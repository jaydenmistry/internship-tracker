import * as cheerio from "cheerio";
import { z } from "zod";
import {
  NormalizedListingSchema,
  type AdapterResult,
  type FetchContext,
  type NormalizedListing,
  type RecordNormalizeResult,
  type SourceAdapter,
} from "./types";

const SOURCE_ID = "intern-list";
const CATEGORY_PAGE_URL = "https://www.intern-list.com/?k=swe";
const MINISITE_BASE = "https://jobright.ai/minisites-jobs/intern";

/**
 * Robots guard (verified 2026-09): jobright.ai robots.txt allows "/" but
 * explicitly disallows "/api/" and "/api/*". Fetching the server-rendered
 * minisite HTML is allowed; calling any jobright.ai API endpoint is not.
 * Called before every fetch this adapter makes.
 */
export function assertAllowedUrl(url: string): void {
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (host === "jobright.ai" || host.endsWith(".jobright.ai")) {
    if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
      throw new Error(
        `intern-list: refusing to fetch ${url} — jobright.ai robots.txt disallows /api/*`,
      );
    }
  }
}

/** Rate-limit sleep between the two page fetches. Injectable so tests never hard-sleep. */
let sleepImpl: (ms: number) => Promise<void> = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Test hook: replace the inter-request sleep. Returns a restore function. */
export function setSleepImplForTests(
  fn: (ms: number) => Promise<void>,
): () => void {
  const previous = sleepImpl;
  sleepImpl = fn;
  return () => {
    sleepImpl = previous;
  };
}

/** Loose shape of one jobright minisite job record — everything else rides along in `raw`. */
const JobRecordSchema = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  company: z.string().min(1),
  location: z.string().nullish(),
  salary: z.string().nullish(),
  postedDate: z.number().nullish(),
  applyUrl: z.string().min(1),
  workModel: z.string().nullish(),
  jobFunction: z.string().nullish(),
  qualifications: z.string().nullish(),
  h1bSponsored: z.string().nullish(),
  hireTime: z.string().nullish(),
});

const NextDataSchema = z.object({
  props: z.object({
    pageProps: z.object({
      initialJobs: z.array(z.unknown()),
      initialTotal: z.number().optional(),
    }),
  }),
});

/** "2027-Summer" → ["Summer 2027"]; anything not matching <year>-<word> → []. */
function hireTimeToTerms(hireTime: string | null | undefined): string[] {
  if (!hireTime) return [];
  const match = /^(\d{4})-(\w+)$/.exec(hireTime);
  if (!match) return [];
  return [`${match[2]} ${match[1]}`];
}

/** Canonical apply URL: strip the entire query string (and hash) — the path alone identifies the job. */
function canonicalUrl(applyUrl: string): string {
  const parsed = new URL(applyUrl);
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

function discoverJobPath(shellHtml: string): string {
  const $ = cheerio.load(shellHtml);
  const candidates = $('h2[short-link="swe"]').filter(
    (_, el) => ($(el).attr("data-job-path") ?? "").startsWith("/us"),
  );
  const jobPath = candidates.first().attr("data-job-path");
  if (!jobPath) {
    throw new Error(
      'intern-list: category element h2[short-link="swe"] with a data-job-path starting with "/us" not found on the intern-list.com shell — page structure changed',
    );
  }
  return jobPath;
}

function extractNextData(minisiteHtml: string): unknown {
  const $ = cheerio.load(minisiteHtml);
  const json = $('script#__NEXT_DATA__[type="application/json"]').html();
  if (!json) {
    throw new Error(
      "intern-list: __NEXT_DATA__ script not found on the jobright minisite page — page structure changed",
    );
  }
  try {
    return JSON.parse(json) as unknown;
  } catch (error) {
    throw new Error(
      `intern-list: __NEXT_DATA__ is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Normalize ONE jobright minisite record — the whole per-record mapping for
 * this source, in one place. The run path calls it per record (and logs the
 * reason a record was dropped); `splitMerge` calls it with a stored
 * `ListingSource.raw` to rebuild a listing that was merged away.
 *
 * The `error` text is phrased to read after "skipping ", which is how the run
 * path logs it.
 */
export function normalizeInternListRecord(rawJob: unknown): RecordNormalizeResult {
  const jobParse = JobRecordSchema.safeParse(rawJob);
  if (!jobParse.success) {
    return {
      ok: false,
      error: `job record failing schema: ${jobParse.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  const job = jobParse.data;

  let candidate: unknown;
  try {
    const postedAt =
      typeof job.postedDate === "number" && Number.isFinite(job.postedDate)
        ? new Date(job.postedDate)
        : undefined;
    candidate = {
      source: SOURCE_ID,
      sourceUid: job.id,
      company: job.company,
      title: job.title,
      url: canonicalUrl(job.applyUrl),
      locations: job.location ? [job.location] : [],
      remote: job.workModel === "Remote",
      category: job.jobFunction ?? "Software Engineering",
      terms: hireTimeToTerms(job.hireTime),
      sponsorship:
        job.h1bSponsored && job.h1bSponsored !== "Not Sure"
          ? `H1B: ${job.h1bSponsored}`
          : undefined,
      salary: job.salary ?? undefined,
      postingText: job.qualifications ? job.qualifications : undefined,
      postedAt,
      active: true,
      raw: rawJob,
    };
  } catch (error) {
    return {
      ok: false,
      error: `job ${job.id}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const listingParse = NormalizedListingSchema.safeParse(candidate);
  if (!listingParse.success) {
    return {
      ok: false,
      error: `job ${job.id} failing NormalizedListing schema: ${listingParse.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, listing: listingParse.data };
}

/** The run path: normalize one record, logging why it was dropped. */
function normalizeJob(rawJob: unknown, ctx: FetchContext): NormalizedListing | null {
  const result = normalizeInternListRecord(rawJob);
  if (result.ok) return result.listing;
  ctx.log(`intern-list: skipping ${result.error}`);
  return null;
}

async function fetchPage(ctx: FetchContext, url: string): Promise<string> {
  assertAllowedUrl(url);
  const response = await ctx.fetch(url, {
    headers: { "User-Agent": ctx.userAgent },
  });
  if (!response.ok) {
    throw new Error(`intern-list: GET ${url} failed with HTTP ${response.status}`);
  }
  return response.text();
}

export const internListAdapter: SourceAdapter = {
  id: SOURCE_ID,
  displayName: "Intern List (SWE)",

  normalizeRecord: (raw) => normalizeInternListRecord(raw),

  async fetch(ctx: FetchContext): Promise<AdapterResult> {
    const shellHtml = await fetchPage(ctx, CATEGORY_PAGE_URL);
    const jobPath = discoverJobPath(shellHtml);
    const minisiteUrl = `${MINISITE_BASE}${jobPath}?embed=true`;

    // Network etiquette: ≥1s between requests.
    await sleepImpl(1000);

    const minisiteHtml = await fetchPage(ctx, minisiteUrl);
    // Persist the raw payload before parsing so parser breakage is debuggable.
    await ctx.saveRaw?.(minisiteHtml);
    const nextData = extractNextData(minisiteHtml);

    const dataParse = NextDataSchema.safeParse(nextData);
    if (!dataParse.success) {
      throw new Error(
        "intern-list: __NEXT_DATA__ shape mismatch — expected props.pageProps.initialJobs array; jobright minisite payload changed",
      );
    }

    const rawJobs = dataParse.data.props.pageProps.initialJobs;
    const listings: NormalizedListing[] = [];
    let skipped = 0;
    for (const rawJob of rawJobs) {
      const listing = normalizeJob(rawJob, ctx);
      if (listing) {
        listings.push(listing);
      } else {
        skipped++;
      }
    }
    if (skipped > 0) {
      ctx.log(
        `intern-list: skipped ${skipped}/${rawJobs.length} invalid job records`,
      );
    }
    ctx.log(
      `intern-list: normalized ${listings.length} listings from ${minisiteUrl} (source total: ${dataParse.data.props.pageProps.initialTotal ?? "unknown"})`,
    );

    return { listings, rawPayload: minisiteHtml };
  },
};
