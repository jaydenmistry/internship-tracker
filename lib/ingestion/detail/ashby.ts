/**
 * Ashby. Page URL: https://jobs.ashbyhq.com/{org}/{uuid} (sometimes with an
 * /application suffix — stripped before fetching). No public JSON API: GET the
 * page HTML and parse its `<script type="application/ld+json">` JobPosting
 * (description is HTML; validThrough → deadline when present). Fall back to
 * `window.__appData` when the ld+json is missing, and then to the public
 * job-board API (api.ashbyhq.com/posting-api/job-board/{org}): a page with
 * neither is usually a closed role, and the board says so — a job that isn't
 * on it is reported "gone" rather than as a parser failure.
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import {
  UnsupportedUrlError,
  extractJobPostingLd,
  htmlToText,
  parseDateMaybe,
  politeFetch,
} from "@/lib/ingestion/detail/net";

export async function fetchAshbyDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const [org, uuid] = u.pathname.split("/").filter(Boolean);
  if (!org || !uuid) throw new UnsupportedUrlError(`unrecognized ashby URL: ${url}`);

  const pageUrl = `${u.origin}/${org}/${uuid}`; // drops /application suffix + query
  const res = await politeFetch(pageUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "ashby", raw };

  try {
    const ld = extractJobPostingLd(raw);
    if (ld?.description) {
      return {
        status: "ok",
        atsKind: "ashby",
        postingText: htmlToText(ld.description),
        deadline: parseDateMaybe(ld.validThrough),
        raw,
      };
    }
    const appDataHtml = extractAppDataDescription(raw);
    if (appDataHtml !== undefined) {
      return { status: "ok", atsKind: "ashby", postingText: htmlToText(appDataHtml), raw };
    }
    return (await fromJobBoard(org, uuid, ctx)) ?? { status: "parse_failed", atsKind: "ashby", raw };
  } catch (err) {
    ctx.log(`ashby parse failed for ${pageUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "ashby", raw };
  }
}

const JobBoardSchema = z.looseObject({
  jobs: z.array(z.looseObject({ id: z.string(), descriptionHtml: z.string().nullish() })),
});

/** The org's public job board: the posting's text, "gone" if it isn't listed, or undefined if the board can't say. */
async function fromJobBoard(org: string, uuid: string, ctx: DetailContext): Promise<DetailResult | undefined> {
  const boardUrl = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org)}`;
  try {
    const res = await politeFetch(boardUrl, ctx);
    if (!res.ok) return undefined;
    const board = JobBoardSchema.parse(await res.json());
    const job = board.jobs.find((j) => j.id.toLowerCase() === uuid.toLowerCase());
    if (!job) return { status: "gone", atsKind: "ashby" };
    if (!job.descriptionHtml) return undefined;
    return { status: "ok", atsKind: "ashby", postingText: htmlToText(job.descriptionHtml) };
  } catch (err) {
    ctx.log(`ashby job board unreadable for ${org}: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Best-effort fallback: pull a description HTML string out of window.__appData. */
function extractAppDataDescription(html: string): string | undefined {
  const match = html.match(/window\.__appData\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/);
  if (!match) return undefined;
  let appData: unknown;
  try {
    appData = JSON.parse(match[1]);
  } catch {
    return undefined;
  }
  return findDescriptionHtml(appData, 0);
}

function findDescriptionHtml(node: unknown, depth: number): string | undefined {
  if (node === null || typeof node !== "object" || depth > 8) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDescriptionHtml(item, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = node as Record<string, unknown>;
  for (const key of ["descriptionHtml", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  for (const value of Object.values(record)) {
    const found = findDescriptionHtml(value, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}
