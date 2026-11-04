/**
 * Company job boards on Greenhouse, Lever and Ashby: which board a link
 * belongs to, the public feed URL for a board, and the mapping from one feed
 * record to a NormalizedListing. Pure — no I/O, no DB, no clock — so the
 * adapter and a merge split (normalizeRecord) share one mapping.
 *
 * Feeds (all public, no key; shapes checked against live boards 2026-11):
 * - Greenhouse: GET boards-api.greenhouse.io/v1/boards/{slug}/jobs?content=true
 *   → { jobs: [{ id, title, absolute_url, location: { name }, content
 *   (entity-escaped HTML), first_published, application_deadline, … }] }
 * - Lever: GET api.lever.co/v0/postings/{slug}?mode=json → [{ id, text,
 *   hostedUrl, categories: { commitment, location, allLocations },
 *   workplaceType, createdAt (ms), descriptionPlain, lists, … }]. Its
 *   robots.txt asks for a 1s crawl delay, which politeFetch already keeps.
 * - Ashby: GET api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true
 *   → { jobs: [{ id, title, employmentType, location, secondaryLocations,
 *   isRemote, isListed, publishedAt, jobUrl, descriptionHtml, compensation }] }
 */
import { z } from "zod";
import { decodeEntities, htmlToText } from "@/lib/ingestion/detail/net";
import { leverPostingText } from "@/lib/ingestion/detail/lever";
import {
  NormalizedListingSchema,
  type NormalizedListing,
  type RecordNormalizeResult,
} from "@/lib/ingestion/adapters/types";

export const BOARDS_SOURCE_ID = "job-boards";

export const BOARD_ATS = ["greenhouse", "lever", "ashby"] as const;
export type BoardAts = (typeof BOARD_ATS)[number];

export const ATS_LABEL: Record<BoardAts, string> = {
  greenhouse: "Greenhouse",
  lever: "Lever",
  ashby: "Ashby",
};

export interface BoardRef {
  ats: BoardAts;
  slug: string;
}

/** One row per board however a link spells it. */
export function boardKey(ref: BoardRef): string {
  return `${ref.ats}:${ref.slug.toLowerCase()}`;
}

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * The board a link points into, or null. Only the hosts whose feed we read:
 * a company's own careers page that embeds Greenhouse (`?gh_jid=`) names no
 * board, and Greenhouse's embed URLs carry it only as `?for=`.
 */
export function boardFromUrl(url: string): BoardRef | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const first = u.pathname.split("/").filter(Boolean)[0];
  let ref: BoardRef | null = null;
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const slug = first === "embed" ? u.searchParams.get("for") : first;
    if (slug) ref = { ats: "greenhouse", slug };
  } else if (host === "jobs.lever.co") {
    if (first) ref = { ats: "lever", slug: first };
  } else if (host === "jobs.ashbyhq.com") {
    if (first) {
      try {
        ref = { ats: "ashby", slug: decodeURIComponent(first) };
      } catch {
        return null; // a malformed %-escape is a bad link, not a crash
      }
    }
  }
  return ref && SLUG_RE.test(ref.slug) ? ref : null;
}

export function feedUrl(ref: BoardRef): string {
  const slug = encodeURIComponent(ref.slug);
  switch (ref.ats) {
    case "greenhouse":
      return `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    case "lever":
      return `https://api.lever.co/v0/postings/${slug}?mode=json`;
    case "ashby":
      return `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
  }
}

/** The board's public page, for people (the /boards list links to it). */
export function boardPageUrl(ref: BoardRef): string {
  const slug = encodeURIComponent(ref.slug);
  switch (ref.ats) {
    case "greenhouse":
      return `https://job-boards.greenhouse.io/${slug}`;
    case "lever":
      return `https://jobs.lever.co/${slug}`;
    case "ashby":
      return `https://jobs.ashbyhq.com/${slug}`;
  }
}

/* ------------------------------------------------------------------ */
/* Which postings to keep                                              */
/* ------------------------------------------------------------------ */

/** "International", "Internal Tools" and "Internationalization" must not match. */
const INTERN_RE = /\b(?:intern|interns|internship|internships|co-?op)\b/i;

/**
 * A tech role, by title. Deliberately broad: role type is the scoring
 * engine's job, so this only keeps out the obvious non-tech internships a
 * company board carries (finance, design, sales, recruiting, …).
 */
const TECH_RE =
  /\b(?:software|engineer|engineering|developer|development|swe|sde|programm(?:er|ing)|data|machine\s+learning|ml|ai|security|infrastructure|platform|back[-\s]?end|front[-\s]?end|full[-\s]?stack|mobile|ios|android|systems?|cloud|devops|sre|reliability|quant(?:itative)?|research|scientist|computer|robotics|firmware|embedded)\b/i;

const SEASON_RE = /\b(summer|fall|autumn|winter|spring)\s*'?(\d{4}|\d{2})\b/gi;
const YEAR_RE = /\b(20\d{2})\b/g;

/** The term this app tracks; other seasons' postings are dropped, like Simplify's. */
export const TARGET_TERM = "Summer 2027";

/**
 * "Software Engineer Intern (Summer 2027)" → ["Summer 2027"]. A title naming
 * no season gives [] (the detail selector and scoring treat that as unknown,
 * not wrong).
 */
export function termsFromTitle(title: string): string[] {
  const terms = new Set<string>();
  for (const m of title.matchAll(SEASON_RE)) {
    const season = m[1].toLowerCase() === "autumn" ? "Fall" : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const year = m[2].length === 2 ? `20${m[2]}` : m[2];
    terms.add(`${season} ${year}`);
  }
  return [...terms];
}

/**
 * Keep: a tech internship that isn't explicitly for another term. A title
 * naming a season keeps only the target term ("Fall 2026" goes); one naming
 * only a year keeps only the target year ("(2026)" goes, "(2027)" stays).
 */
export function isWantedInternship(title: string, internFlag = false): boolean {
  if (!(internFlag || INTERN_RE.test(title)) || !TECH_RE.test(title)) return false;
  const terms = termsFromTitle(title);
  if (terms.length > 0) return terms.includes(TARGET_TERM);
  const years = [...title.matchAll(YEAR_RE)].map((m) => m[1]);
  return years.length === 0 || years.includes(TARGET_TERM.slice(-4));
}

/* ------------------------------------------------------------------ */
/* Feed records                                                        */
/* ------------------------------------------------------------------ */

const GreenhouseJob = z.looseObject({
  id: z.union([z.number(), z.string()]),
  title: z.string().min(1),
  absolute_url: z.string().nullish(),
  location: z.looseObject({ name: z.string().nullish() }).nullish(),
  content: z.string().nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  application_deadline: z.string().nullish(),
});
const GreenhouseFeed = z.looseObject({ jobs: z.array(z.unknown()) });

const LeverJob = z.looseObject({
  id: z.string().min(1),
  text: z.string().min(1),
  hostedUrl: z.string().nullish(),
  categories: z
    .looseObject({
      commitment: z.string().nullish(),
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish(),
  workplaceType: z.string().nullish(),
  createdAt: z.number().nullish(),
});
const LeverFeed = z.array(z.unknown());

const AshbyJob = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  employmentType: z.string().nullish(),
  location: z.string().nullish(),
  secondaryLocations: z.array(z.looseObject({ location: z.string().nullish() })).nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: z.string().nullish(),
  jobUrl: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  compensation: z.looseObject({ scrapeableCompensationSalarySummary: z.string().nullish() }).nullish(),
});
const AshbyFeed = z.looseObject({ jobs: z.array(z.unknown()) });

/**
 * One posting as stored on ListingSource.raw: everything normalizeRecord
 * needs to rebuild the listing without the board.
 */
export interface BoardRecord {
  ats: BoardAts;
  slug: string;
  company: string;
  job: unknown;
}

export interface FeedRead {
  /** Every posting on the board. */
  total: number;
  /** The postings worth ingesting, as stored records. */
  kept: BoardRecord[];
}

/** Records that don't parse are skipped, not fatal: one odd posting can't hide a board. */
export function readFeed(ref: BoardRef, company: string, body: unknown): FeedRead {
  const records =
    ref.ats === "lever"
      ? LeverFeed.parse(body)
      : ref.ats === "greenhouse"
        ? GreenhouseFeed.parse(body).jobs
        : AshbyFeed.parse(body).jobs;
  const kept: BoardRecord[] = [];
  for (const job of records) {
    if (wanted(ref.ats, job)) kept.push({ ats: ref.ats, slug: ref.slug, company, job });
  }
  return { total: records.length, kept };
}

function wanted(ats: BoardAts, job: unknown): boolean {
  switch (ats) {
    case "greenhouse": {
      const j = GreenhouseJob.safeParse(job);
      return j.success && isWantedInternship(j.data.title);
    }
    case "lever": {
      const j = LeverJob.safeParse(job);
      return j.success && isWantedInternship(j.data.text, /intern/i.test(j.data.categories?.commitment ?? ""));
    }
    case "ashby": {
      const j = AshbyJob.safeParse(job);
      return (
        j.success && j.data.isListed !== false && isWantedInternship(j.data.title, j.data.employmentType === "Intern")
      );
    }
  }
}

function dateMaybe(value: string | number | null | undefined): Date | undefined {
  if (value === null || value === undefined) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function isRemoteText(location: string): boolean {
  return /\bremote\b/i.test(location);
}

/**
 * One stored record → a NormalizedListing. The listing's URL is the ATS's own
 * posting URL, never the company page Greenhouse's `absolute_url` often points
 * to: that URL is what carries the job id (lib/ingestion/normalize.ts's
 * extractRequisitionId), and a shared job id is what merges this posting with
 * the same role from Simplify instead of listing it twice.
 */
export function normalizeBoardRecord(raw: unknown): RecordNormalizeResult {
  try {
    return normalizeUnsafe(raw);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeUnsafe(raw: unknown): RecordNormalizeResult {
  const rec = z
    .object({ ats: z.enum(BOARD_ATS), slug: z.string().min(1), company: z.string().min(1), job: z.unknown() })
    .safeParse(raw);
  if (!rec.success) return { ok: false, error: "not a job-board record" };
  const { ats, slug, company } = rec.data;
  const base = { source: BOARDS_SOURCE_ID, company, active: true, companyFaangPlus: false, raw };
  const enc = encodeURIComponent(slug);

  let candidate: Record<string, unknown>;
  if (ats === "greenhouse") {
    const j = GreenhouseJob.safeParse(rec.data.job);
    if (!j.success) return { ok: false, error: "Greenhouse posting is missing its id or title" };
    const location = j.data.location?.name?.trim() ?? "";
    const locations = location ? location.split(/\s*[•;|]\s*/).filter(Boolean) : [];
    candidate = {
      ...base,
      sourceUid: `greenhouse:${slug.toLowerCase()}:${j.data.id}`,
      title: j.data.title.trim(),
      url: `https://job-boards.greenhouse.io/${enc}/jobs/${j.data.id}`,
      locations,
      remote: isRemoteText(location),
      terms: termsFromTitle(j.data.title),
      postingText: j.data.content ? htmlToText(decodeEntities(j.data.content)) || undefined : undefined,
      postedAt: dateMaybe(j.data.first_published),
      updatedAt: dateMaybe(j.data.updated_at),
      deadline: dateMaybe(j.data.application_deadline),
    };
  } else if (ats === "lever") {
    const j = LeverJob.safeParse(rec.data.job);
    if (!j.success) return { ok: false, error: "Lever posting is missing its id or title" };
    const all = j.data.categories?.allLocations ?? [];
    const locations = all.length > 0 ? all : j.data.categories?.location ? [j.data.categories.location] : [];
    candidate = {
      ...base,
      sourceUid: `lever:${slug.toLowerCase()}:${j.data.id.toLowerCase()}`,
      title: j.data.text.trim(),
      url: `https://jobs.lever.co/${enc}/${j.data.id}`,
      locations,
      remote: j.data.workplaceType === "remote" || locations.some(isRemoteText),
      terms: termsFromTitle(j.data.text),
      postingText: leverPostingText(rec.data.job) || undefined,
      postedAt: dateMaybe(j.data.createdAt),
    };
  } else {
    const j = AshbyJob.safeParse(rec.data.job);
    if (!j.success) return { ok: false, error: "Ashby posting is missing its id or title" };
    const locations = [j.data.location, ...(j.data.secondaryLocations ?? []).map((s) => s.location)]
      .map((l) => l?.trim())
      .filter((l): l is string => !!l);
    const text = j.data.descriptionHtml ? htmlToText(j.data.descriptionHtml) : j.data.descriptionPlain?.trim();
    candidate = {
      ...base,
      sourceUid: `ashby:${slug.toLowerCase()}:${j.data.id.toLowerCase()}`,
      title: j.data.title.trim(),
      url: `https://jobs.ashbyhq.com/${enc}/${j.data.id}`,
      locations: [...new Set(locations)],
      remote: j.data.isRemote === true,
      terms: termsFromTitle(j.data.title),
      salary: j.data.compensation?.scrapeableCompensationSalarySummary?.trim() || undefined,
      postingText: text || undefined,
      postedAt: dateMaybe(j.data.publishedAt),
    };
  }

  const parsed = NormalizedListingSchema.safeParse({ ...candidate, fetchedFromAts: ats });
  return parsed.success
    ? { ok: true, listing: parsed.data as NormalizedListing }
    : { ok: false, error: parsed.error.issues[0]?.message ?? "invalid listing" };
}
