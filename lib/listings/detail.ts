import { prisma } from "@/lib/db";
import type { AppStatus } from "@/generated/prisma/enums";
import { COMPONENT_NAMES, loadScoringConfig, type ComponentName } from "@/lib/scoring/config";
import { buildVocabulary, extractKeywords, matchResume } from "@/lib/resume/match";

/**
 * Read model for the detail panel: everything about one listing that the lean
 * table row leaves out. Loaded on demand when a row is opened.
 *
 * All strings that originate from sources, posting pages or the model
 * (evidence, rationale, titles, notes) are untrusted — render as plain text.
 */

export interface ComponentDetail {
  name: ComponentName;
  points: number;
  max: number;
  /** Relative weight from config/scoring.json. */
  weight: number;
  /** Points this component adds to the 0–100 score (same formula as the engine). */
  contribution: number;
  evidence: string[];
}

export interface TimelineEvent {
  fromStatus: AppStatus | null;
  toStatus: AppStatus;
  occurredAt: string;
  note: string | null;
}

export type ResumeMatchState =
  /** Nothing to compare: the posting has no description text. */
  | { state: "no-posting-text" }
  /** Posting keywords are known, but no resume has been uploaded yet. */
  | { state: "no-resume"; postingKeywords: string[] }
  | { state: "matched"; hits: string[]; misses: string[]; resumeUploadedAt: string };

export interface FetchStatusInfo {
  status: string | null;
  label: string;
  /** Plain-language explanation, including that the score doesn't depend on text. */
  detail: string;
  /** True when a fetch was attempted and did not yield text. */
  failed: boolean;
}

export interface ListingDetail {
  id: string;
  company: string;
  faangPlus: boolean;
  title: string;
  locations: string[];
  remote: boolean;
  url: string;
  requisitionId: string | null;
  salary: string | null;
  sponsorship: string | null;
  degrees: string[];
  terms: string[];
  category: string | null;
  sources: Array<{ source: string; url: string; active: boolean; lastSeen: string }>;

  score: number | null;
  ruleScore: number | null;
  /** What the listing would score if it weren't disqualified (sum of contributions). */
  undisqualifiedScore: number | null;
  llmAdjustment: number | null;
  rank: number | null;
  previousRank: number | null;
  rankChangedAt: string | null;
  components: ComponentDetail[];
  scoredAt: string | null;

  disqualified: boolean;
  /** Every reason, in engine order. */
  disqualifyReasons: string[];
  likelyClosed: boolean;

  /** The stage-2 assessment for the CURRENT posting text, or null (none run). */
  llm: { adjustment: number; rationale: string; model: string; createdAt: string } | null;

  hasPostingText: boolean;
  atsKind: string | null;
  fetch: FetchStatusInfo;

  postedAt: string | null;
  firstSeen: string;
  deadline: string | null;
  saved: boolean;
  dismissed: boolean;

  application: {
    id: string;
    status: AppStatus;
    appliedAt: string | null;
    notes: string | null;
    requisitionId: string | null;
    applyUrl: string | null;
    timeline: TimelineEvent[];
  } | null;

  resumeMatch: ResumeMatchState;
}

const FETCH_LABELS: Record<string, string> = {
  ok: "Fetched",
  http_403: "Blocked (HTTP 403)",
  robots_denied: "Disallowed by robots.txt",
  parse_failed: "Page fetched, but couldn't be parsed",
  unsupported_url: "Unrecognized posting URL",
  fetch_failed: "Network error",
  http_404: "Posting not found (404)",
  http_410: "Posting removed (410)",
};

/** Human description of a posting-fetch outcome, shared by table and panel. */
export function describeFetchStatus(status: string | null, hasText: boolean): FetchStatusInfo {
  const textIndependent =
    "Its score was computed without posting text — tech fit only sees the title, so treat the score as a floor, not a verdict.";
  if (status === null) {
    return hasText
      ? {
          status,
          label: "Text from source",
          detail: "The source listing included description text; no posting page fetch was needed.",
          failed: false,
        }
      : {
          status,
          label: "Not fetched yet",
          detail: `The posting page hasn't been fetched (it may be below the fetch gate). ${textIndependent}`,
          failed: false,
        };
  }
  if (status === "ok") {
    return { status, label: "Fetched", detail: "Posting text was fetched and scored.", failed: false };
  }
  const label = FETCH_LABELS[status] ?? (status.startsWith("http_") ? `HTTP ${status.slice(5)}` : status);
  return {
    status,
    label,
    detail: `The posting page couldn't be fetched (${label}). ${textIndependent}`,
    failed: true,
  };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export async function loadListingDetail(id: string): Promise<ListingDetail | null> {
  const l = await prisma.listing.findUnique({
    where: { id },
    include: {
      company: { select: { name: true, faangPlus: true } },
      sources: { select: { source: true, url: true, active: true, lastSeen: true } },
      application: {
        include: { events: { orderBy: { occurredAt: "asc" } } },
      },
      assessments: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!l) return null;

  const { config } = loadScoringConfig();

  // Mirrors the engine: weights <= 0 are excluded, contributions share one
  // denominator, so the column of contributions sums to the (pre-DQ) score.
  const breakdown = (l.scoreBreakdown ?? null) as Record<
    string,
    { points: number; max: number; evidence: string[] }
  > | null;
  const activeWeights = COMPONENT_NAMES.filter((n) => (config.weights[n] ?? 0) > 0);
  const weightSum = activeWeights.reduce((s, n) => s + (config.weights[n] ?? 0), 0);
  const components: ComponentDetail[] = breakdown
    ? COMPONENT_NAMES.map((name) => {
        const c = breakdown[name] ?? { points: 0, max: 0, evidence: [] };
        const weight = config.weights[name] ?? 0;
        const contribution =
          weight > 0 && weightSum > 0 && c.max > 0 ? (100 * weight * (c.points / c.max)) / weightSum : 0;
        return {
          name,
          points: c.points,
          max: c.max,
          weight,
          contribution: Math.round(contribution * 10) / 10,
          evidence: c.evidence ?? [],
        };
      })
    : [];
  const undisqualifiedScore = breakdown
    ? Math.round(components.reduce((s, c) => s + c.contribution, 0))
    : null;

  // Only an assessment of the CURRENT text applies; older ones are stale.
  const assessment = l.postingTextHash
    ? l.assessments.find((a) => a.textHash === l.postingTextHash)
    : undefined;

  let resumeMatch: ResumeMatchState;
  if (!l.postingText) {
    resumeMatch = { state: "no-posting-text" };
  } else {
    const vocabulary = buildVocabulary(config);
    const resume = await prisma.resume.findFirst({
      where: { active: true },
      orderBy: { uploadedAt: "desc" },
      select: { text: true, uploadedAt: true },
    });
    resumeMatch = resume
      ? {
          state: "matched",
          ...matchResume(l.postingText, resume.text, vocabulary),
          resumeUploadedAt: resume.uploadedAt.toISOString(),
        }
      : { state: "no-resume", postingKeywords: extractKeywords(l.postingText, vocabulary) };
  }

  return {
    id: l.id,
    company: l.company.name,
    faangPlus: l.company.faangPlus,
    title: l.title,
    locations: l.locations,
    remote: l.remote,
    url: l.url,
    requisitionId: l.requisitionId,
    salary: l.salary,
    sponsorship: l.sponsorship,
    degrees: l.degrees,
    terms: l.terms,
    category: l.category,
    sources: l.sources.map((s) => ({
      source: s.source,
      url: s.url,
      active: s.active,
      lastSeen: s.lastSeen.toISOString(),
    })),
    score: l.finalScore,
    ruleScore: l.ruleScore,
    undisqualifiedScore,
    llmAdjustment: l.llmAdjustment,
    rank: l.rank,
    previousRank: l.previousRank,
    rankChangedAt: iso(l.rankChangedAt),
    components,
    scoredAt: iso(l.scoredAt),
    disqualified: l.disqualified,
    disqualifyReasons: l.disqualifyReasons,
    likelyClosed: l.likelyClosed,
    llm: assessment
      ? {
          adjustment: assessment.adjustment,
          rationale: assessment.rationale,
          model: assessment.model,
          createdAt: assessment.createdAt.toISOString(),
        }
      : null,
    hasPostingText: l.postingText !== null,
    atsKind: l.atsKind,
    fetch: describeFetchStatus(l.detailFetchStatus, l.postingText !== null),
    postedAt: iso(l.postedAt),
    firstSeen: l.firstSeen.toISOString(),
    deadline: iso(l.deadline),
    saved: l.saved,
    dismissed: l.dismissed,
    application: l.application
      ? {
          id: l.application.id,
          status: l.application.status,
          appliedAt: iso(l.application.appliedAt),
          notes: l.application.notes,
          requisitionId: l.application.requisitionId,
          applyUrl: l.application.applyUrl,
          timeline: l.application.events.map((e) => ({
            fromStatus: e.fromStatus,
            toStatus: e.toStatus,
            occurredAt: e.occurredAt.toISOString(),
            note: e.note,
          })),
        }
      : null,
    resumeMatch,
  };
}
