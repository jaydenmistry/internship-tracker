/**
 * Workable. Page URL: https://apply.workable.com/{account}/j/{shortcode}[/apply].
 * The page is client-rendered (the generic fallback found nothing in it); the
 * same data comes from its public API:
 *   GET https://apply.workable.com/api/v2/accounts/{account}/jobs/{shortcode}
 * → {title, description, requirements, benefits} (HTML strings). No deadline.
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import { UnsupportedUrlError, htmlToText, politeFetch } from "@/lib/ingestion/detail/net";

const WorkableJobSchema = z.looseObject({
  title: z.string().nullish(),
  shortcode: z.string().nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  benefits: z.string().nullish(),
});

const PATH_RE = /^\/([^/]+)\/j\/([A-Za-z0-9]+)/;

export async function fetchWorkableDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const match = u.pathname.match(PATH_RE);
  if (!match) throw new UnsupportedUrlError(`unrecognized Workable URL: ${url}`);
  const [, account, shortcode] = match;

  const apiUrl = `https://apply.workable.com/api/v2/accounts/${encodeURIComponent(account)}/jobs/${shortcode}`;
  const res = await politeFetch(apiUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "workable", raw };

  try {
    const job = WorkableJobSchema.parse(JSON.parse(raw));
    const postingText = [job.description, job.requirements, job.benefits]
      .map((part) => (part ? htmlToText(part) : ""))
      .filter(Boolean)
      .join("\n\n");
    if (postingText === "") return { status: "parse_failed", atsKind: "workable", raw };
    return { status: "ok", atsKind: "workable", postingText, raw };
  } catch (err) {
    ctx.log(`workable parse failed for ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "workable", raw };
  }
}
