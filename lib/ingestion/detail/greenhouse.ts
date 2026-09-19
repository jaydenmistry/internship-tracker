/**
 * Greenhouse. Page URLs: https://boards.greenhouse.io/{board}/jobs/{id} and
 * https://job-boards.greenhouse.io/{board}/jobs/{id}.
 * API: GET https://boards-api.greenhouse.io/v1/boards/{board}/jobs/{id} — JSON
 * whose `content` is ENTITY-ESCAPED HTML (&lt;p&gt; style): decode entities
 * first, then strip tags. `application_deadline` is nullable.
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import {
  UnsupportedUrlError,
  decodeEntities,
  htmlToText,
  parseDateMaybe,
  politeFetch,
} from "@/lib/ingestion/detail/net";

const GreenhouseJobSchema = z.looseObject({
  title: z.string().optional(),
  content: z.string(),
  application_deadline: z.string().nullish(),
  requisition_id: z.union([z.string(), z.number()]).nullish(),
});

/**
 * Follows a greenhouse embed URL to discover which board it belongs to.
 * boards.greenhouse.io/embed/job_app?token=N redirects to
 * job-boards.greenhouse.io/embed/job_app?for={board}&token=N.
 */
async function resolveEmbedBoard(url: string, ctx: DetailContext): Promise<string | undefined> {
  const res = await politeFetch(url, ctx);
  // Read the body so the connection isn't left dangling; only the final URL matters.
  await res.text().catch(() => "");
  try {
    return new URL(res.url).searchParams.get("for") ?? undefined;
  } catch {
    return undefined;
  }
}

export async function fetchGreenhouseDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  let board: string | undefined;
  let jobId: string | undefined;

  const match = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (match) {
    [, board, jobId] = match;
  } else if (/\/embed\/job_app$/.test(u.pathname)) {
    // Embed form: /embed/job_app?token={jobId}. The board isn't in the URL,
    // but the redirect target carries it as ?for={board}.
    const token = u.searchParams.get("token");
    const forParam = u.searchParams.get("for");
    if (!token) throw new UnsupportedUrlError(`greenhouse embed URL without token: ${url}`);
    jobId = token;
    board = forParam ?? (await resolveEmbedBoard(url, ctx));
  }

  if (!board || !jobId) throw new UnsupportedUrlError(`unrecognized greenhouse URL: ${url}`);

  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`;
  const res = await politeFetch(apiUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "greenhouse", raw };

  try {
    const job = GreenhouseJobSchema.parse(JSON.parse(raw));
    const postingText = htmlToText(decodeEntities(job.content));
    return {
      status: "ok",
      atsKind: "greenhouse",
      postingText,
      deadline: parseDateMaybe(job.application_deadline),
      requisitionId: job.requisition_id != null ? String(job.requisition_id) : undefined,
      raw,
    };
  } catch (err) {
    ctx.log(`greenhouse parse failed for ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "greenhouse", raw };
  }
}
