/**
 * Network etiquette + shared parsing helpers for detail fetchers.
 *
 * - robots.txt honored for the host we ACTUALLY fetch (may differ from the
 *   listing host, e.g. greenhouse page → boards-api.greenhouse.io). Verdicts
 *   cached per host in ctx.robotsCache; a robots fetch error/404 → allowed.
 * - ≥ RATE_LIMIT_MS between requests to the same host, via injectable sleep.
 * - 15s AbortSignal timeout and a real User-Agent on every request.
 */
import * as cheerio from "cheerio";
import robotsParser from "robots-parser";
import { z } from "zod";
import type { DetailContext } from "@/lib/ingestion/detail/index";

/** robots-parser doesn't export its Robot type; the slice we use. */
interface RobotsVerdict {
  isAllowed(url: string, ua?: string): boolean | undefined;
}

export class RobotsDeniedError extends Error {}
export class UnsupportedUrlError extends Error {}

export const RATE_LIMIT_MS = 1000;
export const FETCH_TIMEOUT_MS = 15_000;

/** Fallback last-fetch-per-host maps, one per run, keyed by the run's urlCache. */
const fallbackRateMaps = new WeakMap<object, Map<string, number>>();

function rateMap(ctx: DetailContext): Map<string, number> {
  if (ctx.lastFetchByHost) return ctx.lastFetchByHost;
  let m = fallbackRateMaps.get(ctx.urlCache);
  if (!m) {
    m = new Map();
    fallbackRateMaps.set(ctx.urlCache, m);
  }
  return m;
}

async function rateLimitedFetch(target: URL, ctx: DetailContext): Promise<Response> {
  const nowMs = ctx.nowMs ?? Date.now;
  const hosts = rateMap(ctx);
  const last = hosts.get(target.hostname);
  if (last !== undefined) {
    const wait = RATE_LIMIT_MS - (nowMs() - last);
    if (wait > 0) await ctx.sleep(wait);
  }
  hosts.set(target.hostname, nowMs());
  return ctx.fetch(target.toString(), {
    headers: { "User-Agent": ctx.userAgent },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
}

async function isAllowedByRobots(target: URL, ctx: DetailContext): Promise<boolean> {
  const host = target.hostname;
  let verdict = ctx.robotsCache.get(host) as RobotsVerdict | true | undefined;
  if (verdict === undefined) {
    try {
      const res = await rateLimitedFetch(new URL(`${target.origin}/robots.txt`), ctx);
      if (!res.ok) {
        verdict = true; // missing/erroring robots.txt → allowed, per convention
      } else {
        verdict = robotsParser(`${target.origin}/robots.txt`, await res.text());
      }
    } catch {
      verdict = true;
    }
    ctx.robotsCache.set(host, verdict);
  }
  if (verdict === true) return true;
  // undefined (no matching rule) counts as allowed; only an explicit false denies.
  return verdict.isAllowed(target.toString(), ctx.userAgent) !== false;
}

const PRIVATE_IPV4 =
  /^(?:127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * SSRF guard: listing URLs come from external sources, so refuse non-HTTP
 * schemes and loopback/private/link-local hosts before any fetch happens.
 */
export function assertPublicHttpUrl(target: URL): void {
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new UnsupportedUrlError(`refusing non-http(s) scheme: ${target.protocol}`);
  }
  const host = target.hostname.toLowerCase();
  const bareV6 = host.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    PRIVATE_IPV4.test(host) ||
    bareV6 === "::1" ||
    bareV6 === "::" ||
    /^(?:fc|fd|fe8)/i.test(bareV6)
  ) {
    throw new UnsupportedUrlError(`refusing private/loopback host: ${host}`);
  }
}

/**
 * Robots-checked, rate-limited fetch. Throws RobotsDeniedError WITHOUT fetching
 * the target when its host's robots.txt disallows the path, and
 * UnsupportedUrlError for non-HTTP schemes and private/loopback hosts.
 */
export async function politeFetch(url: string, ctx: DetailContext): Promise<Response> {
  const target = new URL(url);
  assertPublicHttpUrl(target);
  if (!(await isAllowedByRobots(target, ctx))) {
    throw new RobotsDeniedError(`robots.txt disallows ${url}`);
  }
  return rateLimitedFetch(target, ctx);
}

/* ------------------------------------------------------------------ */
/* HTML → text                                                         */
/* ------------------------------------------------------------------ */

const BLOCK_SELECTOR =
  "p, div, li, ul, ol, h1, h2, h3, h4, h5, h6, tr, table, section, article, blockquote, pre, dt, dd";

/**
 * HTML string → plain text: entity-decoded, tags stripped, paragraph/list
 * breaks preserved as newlines, blank-line runs collapsed, trimmed.
 */
export function htmlToText(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, template, iframe, svg").remove();
  $("br").replaceWith("\n");
  $(BLOCK_SELECTOR).each((_, el) => {
    $(el).prepend("\n").append("\n");
  });
  return collapseWhitespace($("body").text());
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/ /g, " ")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Decode HTML entities in a string (Greenhouse's `content` is entity-escaped
 * markup: "&lt;p&gt;…" — decode first, then strip tags with htmlToText).
 */
export function decodeEntities(escaped: string): string {
  return cheerio.load(`<body>${escaped.replace(/</g, "&lt;")}</body>`)("body").text();
}

/** Parse a date string defensively; undefined when absent or invalid. */
export function parseDateMaybe(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/* ------------------------------------------------------------------ */
/* JSON-LD JobPosting extraction (Ashby + generic pages)               */
/* ------------------------------------------------------------------ */

export const JobPostingLdSchema = z.looseObject({
  "@type": z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  datePosted: z.string().optional(),
  validThrough: z.string().optional(),
});
export type JobPostingLd = z.infer<typeof JobPostingLdSchema>;

/** Find the first `<script type="application/ld+json">` JobPosting in a page. */
export function extractJobPostingLd(html: string): JobPostingLd | undefined {
  const $ = cheerio.load(html);
  for (const el of $('script[type="application/ld+json"]').toArray()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse($(el).text());
    } catch {
      continue;
    }
    const graph = (parsed as { "@graph"?: unknown })?.["@graph"];
    const candidates: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(graph)
        ? graph
        : [parsed];
    for (const candidate of candidates) {
      if (
        candidate !== null &&
        typeof candidate === "object" &&
        (candidate as Record<string, unknown>)["@type"] === "JobPosting"
      ) {
        const checked = JobPostingLdSchema.safeParse(candidate);
        if (checked.success) return checked.data;
      }
    }
  }
  return undefined;
}
