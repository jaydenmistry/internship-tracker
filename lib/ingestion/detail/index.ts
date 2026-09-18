/**
 * Stage 3: posting-detail fetchers. Given a listing's apply URL, resolve the
 * ATS behind it, fetch the posting (JSON API where one exists, HTML otherwise),
 * and extract plain-text description + deadline.
 *
 * All network I/O goes through the injected ctx.fetch and the etiquette layer
 * in net.ts (robots.txt, per-host rate limit, timeouts, User-Agent). Results —
 * including failures — are cached in ctx.urlCache so a URL is never fetched
 * twice in one run.
 */
import { fetchGreenhouseDetail } from "@/lib/ingestion/detail/greenhouse";
import { fetchLeverDetail } from "@/lib/ingestion/detail/lever";
import { fetchAshbyDetail } from "@/lib/ingestion/detail/ashby";
import { fetchWorkdayDetail } from "@/lib/ingestion/detail/workday";
import { fetchGenericDetail } from "@/lib/ingestion/detail/generic";
import { RobotsDeniedError, UnsupportedUrlError } from "@/lib/ingestion/detail/net";

export type AtsKind = "greenhouse" | "lever" | "ashby" | "workday" | "generic";

/** Hard cap on extracted description length. */
export const MAX_POSTING_TEXT = 20_000;

export interface DetailResult {
  /** "ok" | "http_<code>" | "parse_failed" | "robots_denied" | "unsupported_url" | "fetch_failed" */
  status: string;
  atsKind: AtsKind;
  /** Plain text, entity-decoded, tags stripped, ≤ MAX_POSTING_TEXT chars. */
  postingText?: string;
  deadline?: Date;
  requisitionId?: string;
  /** The raw fetched body (pre-parse) for debugging. */
  raw?: string;
}

export interface DetailContext {
  fetch: typeof globalThis.fetch;
  userAgent: string;
  now: Date;
  log(message: string): void;
  /** Injectable for tests — the rate limiter awaits this instead of a real timer. */
  sleep(ms: number): Promise<void>;
  /** Per-host robots.txt verdict cache, caller-owned. */
  robotsCache: Map<string, unknown>;
  /** In-run URL cache, caller-owned — never fetch the same URL twice in one run. */
  urlCache: Map<string, DetailResult>;
  /** Optional injectable millisecond clock for the rate limiter (defaults to Date.now). */
  nowMs?: () => number;
  /** Optional caller-owned last-fetch-per-host map; defaults to an internal per-run map. */
  lastFetchByHost?: Map<string, number>;
}

/** Classify an apply URL by ATS. Unknown/invalid URLs are "generic". */
export function detectAtsKind(url: string): AtsKind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "generic";
  }
  const host = u.hostname.toLowerCase();
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io" || host.endsWith(".greenhouse.io")) {
    return "greenhouse";
  }
  if (host === "jobs.lever.co") return "lever";
  if (host === "jobs.ashbyhq.com") return "ashby";
  if (/\.wd\d+\.myworkdayjobs\.com$/.test(host)) return "workday";
  return "generic";
}

const handlers: Record<AtsKind, (url: string, ctx: DetailContext) => Promise<DetailResult>> = {
  greenhouse: fetchGreenhouseDetail,
  lever: fetchLeverDetail,
  ashby: fetchAshbyDetail,
  workday: fetchWorkdayDetail,
  generic: fetchGenericDetail,
};

export async function fetchDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const cached = ctx.urlCache.get(url);
  if (cached) return cached;

  // Reject unparseable URLs before the try: inside it, a TypeError is what
  // undici's fetch throws on DNS/connection failures, which must NOT be
  // misclassified as unsupported_url.
  try {
    new URL(url);
  } catch {
    const result: DetailResult = { status: "unsupported_url", atsKind: "generic" };
    ctx.urlCache.set(url, result);
    return result;
  }

  let result: DetailResult;
  const atsKind: AtsKind = detectAtsKind(url);
  try {
    result = await handlers[atsKind](url, ctx);
  } catch (err) {
    if (err instanceof RobotsDeniedError) {
      result = { status: "robots_denied", atsKind };
    } else if (err instanceof UnsupportedUrlError) {
      result = { status: "unsupported_url", atsKind };
    } else {
      ctx.log(
        `detail fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      result = { status: "fetch_failed", atsKind };
    }
  }

  if (result.postingText !== undefined && result.postingText.length > MAX_POSTING_TEXT) {
    result = { ...result, postingText: result.postingText.slice(0, MAX_POSTING_TEXT) };
  }
  ctx.urlCache.set(url, result);
  return result;
}
