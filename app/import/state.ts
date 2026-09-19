import { isPreselected, type MatchVerdict, type RowMatch } from "@/lib/applications/import";
import type { CatalogHit, ReviewCandidate, ReviewRow } from "./types";

/**
 * Pure decision state for the review step. No React, no DOM, no I/O — the
 * reducer, the defaults and the summary are all plain functions so they can be
 * tested directly (and so the server action can reuse `toReviewRows`).
 */

export type RowAction = "link" | "manual" | "skip";

export interface RowDecision {
  action: RowAction;
  /** Only meaningful for `action: "link"`. */
  listingId: string | null;
  /** False until the user changes this row, which drives the "needs a look" count. */
  touched: boolean;
}

export type DecisionMap = Record<string, RowDecision>;

/** Shapes one matcher result for the client, dropping everything the UI will not render. */
function toCandidate(
  c: RowMatch["best"] | RowMatch["alternatives"][number],
): ReviewCandidate | null {
  if (!c) return null;
  return {
    listingId: c.listing.id,
    company: c.listing.company,
    title: c.listing.title,
    location: c.listing.locations.join(", "),
    score: c.listing.finalScore,
    url: c.listing.url,
    alreadyApplied: c.listing.applied,
    confidence: c.confidence,
    reasons: c.reasons,
  };
}

export function toReviewRows(matches: RowMatch[]): ReviewRow[] {
  return matches.map((m) => ({
    key: String(m.row.lineNumber),
    row: m.row,
    verdict: m.verdict,
    best: toCandidate(m.best),
    alternatives: m.alternatives
      .map(toCandidate)
      .filter((c): c is ReviewCandidate => c !== null),
    companyContext: m.companyContext,
  }));
}

/**
 * A row is pre-selected for linking only when `isPreselected` says so. Anything
 * weaker defaults to "skip": a wrong link silently marks the wrong role applied
 * and hides it from the table, which is far worse than an unimported row.
 */
export function defaultDecision(row: ReviewRow): RowDecision {
  if (row.best && isPreselected(row.verdict)) {
    return { action: "link", listingId: row.best.listingId, touched: false };
  }
  return { action: "skip", listingId: null, touched: false };
}

export function initialDecisions(rows: ReviewRow[]): DecisionMap {
  const out: DecisionMap = {};
  for (const row of rows) out[row.key] = defaultDecision(row);
  return out;
}

export interface DecisionSummary {
  link: number;
  manual: number;
  skip: number;
  /** Skipped rows the user has not looked at yet — these are easy to lose silently. */
  untouched: number;
  total: number;
}

export function summarize(rows: ReviewRow[], decisions: DecisionMap): DecisionSummary {
  const summary: DecisionSummary = {
    link: 0,
    manual: 0,
    skip: 0,
    untouched: 0,
    total: rows.length,
  };
  for (const row of rows) {
    const d = decisions[row.key] ?? defaultDecision(row);
    if (d.action === "link" && d.listingId) summary.link += 1;
    else if (d.action === "manual") summary.manual += 1;
    else {
      summary.skip += 1;
      if (!d.touched) summary.untouched += 1;
    }
  }
  return summary;
}

export type DecisionEvent =
  | { type: "reset"; rows: ReviewRow[] }
  | { type: "set"; key: string; action: RowAction; listingId?: string | null }
  | { type: "toggle"; row: ReviewRow }
  | { type: "bulk"; rows: ReviewRow[]; action: RowAction };

export function decisionsReducer(state: DecisionMap, event: DecisionEvent): DecisionMap {
  switch (event.type) {
    case "reset":
      return initialDecisions(event.rows);

    case "set":
      return {
        ...state,
        [event.key]: {
          action: event.action,
          listingId: event.action === "link" ? (event.listingId ?? null) : null,
          touched: true,
        },
      };

    /** Space/Enter on a focused row: include it, or drop it if already included. */
    case "toggle": {
      const current = state[event.row.key] ?? defaultDecision(event.row);
      if (current.action === "skip") {
        const listingId = current.listingId ?? event.row.best?.listingId ?? null;
        return {
          ...state,
          [event.row.key]: {
            action: listingId ? "link" : "manual",
            listingId,
            touched: true,
          },
        };
      }
      return {
        ...state,
        [event.row.key]: { action: "skip", listingId: current.listingId, touched: true },
      };
    }

    case "bulk": {
      const next = { ...state };
      for (const row of event.rows) {
        if (event.action === "link" && !row.best) continue;
        next[row.key] = {
          action: event.action,
          listingId: event.action === "link" ? (row.best?.listingId ?? null) : null,
          touched: true,
        };
      }
      return next;
    }
  }
}

export interface CommitRowInput {
  lineNumber: number;
  company: string;
  role: string;
  location?: string;
  requisitionId?: string;
  url?: string;
  raw: string;
  listingId: string | null;
}

/** Drops skipped rows and flattens the rest into the server action's payload. */
export function buildCommitPayload(
  rows: ReviewRow[],
  decisions: DecisionMap,
): CommitRowInput[] {
  const out: CommitRowInput[] = [];
  for (const row of rows) {
    const d = decisions[row.key] ?? defaultDecision(row);
    if (d.action === "skip") continue;
    if (d.action === "link" && !d.listingId) continue;
    out.push({
      lineNumber: row.row.lineNumber,
      company: row.row.company,
      role: row.row.role,
      location: row.row.location,
      requisitionId: row.row.requisitionId,
      url: row.row.url,
      raw: row.row.raw,
      listingId: d.action === "link" ? d.listingId : null,
    });
  }
  return out;
}

export interface VerdictMeta {
  label: string;
  /** Text colour for the verdict word. */
  textClass: string;
  /** Background for the confidence bar. */
  barClass: string;
}

const VERDICT_META: Record<MatchVerdict, VerdictMeta> = {
  exact: { label: "exact", textClass: "text-ok", barClass: "bg-ok" },
  strong: { label: "strong", textClass: "text-ok", barClass: "bg-ok" },
  likely: { label: "likely", textClass: "text-warn", barClass: "bg-warn" },
  weak: { label: "weak", textClass: "text-bad", barClass: "bg-bad" },
  none: { label: "no match", textClass: "text-faint", barClass: "bg-faint" },
};

export function verdictMeta(verdict: MatchVerdict): VerdictMeta {
  return VERDICT_META[verdict];
}

/** "0.87" — matcher confidences are compared by eye, so keep the width stable. */
export function formatConfidence(confidence: number | null | undefined): string {
  if (confidence === null || confidence === undefined) return "—";
  return confidence.toFixed(2);
}

/**
 * React escapes text, but it does NOT escape `href` — `javascript:` in an
 * attribute is the one XSS vector left open, and listing URLs are scraped. Any
 * href rendered from untrusted data goes through this first.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Turns a catalog search hit into a candidate the decision UI can link to. */
export function hitToCandidate(hit: CatalogHit): ReviewCandidate {
  return {
    listingId: hit.listingId,
    company: hit.company,
    title: hit.title,
    location: hit.location,
    score: hit.score,
    url: "",
    alreadyApplied: hit.alreadyApplied,
    confidence: 0,
    reasons: ["picked by hand"],
  };
}

/** Candidates offered for one row, best first, without duplicate listings. */
export function candidatesFor(
  row: ReviewRow,
  extra: ReviewCandidate[] = [],
): ReviewCandidate[] {
  const seen = new Set<string>();
  const out: ReviewCandidate[] = [];
  for (const c of [row.best, ...row.alternatives, ...extra]) {
    if (!c || seen.has(c.listingId)) continue;
    seen.add(c.listingId);
    out.push(c);
  }
  return out;
}
