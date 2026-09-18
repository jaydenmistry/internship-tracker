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

export async function fetchGreenhouseDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const match = u.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (!match) throw new UnsupportedUrlError(`unrecognized greenhouse URL: ${url}`);
  const [, board, jobId] = match;

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
