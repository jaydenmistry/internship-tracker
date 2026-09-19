/**
 * Workday. Page URL:
 *   https://{tenant}.wd{N}.myworkdayjobs.com/[{locale}/]{site}/job/[{location}/]{slug}
 * where the slug ends _{REQID} and locale segments (en-US, fr-CA, …) are
 * skipped when extracting {site}.
 * API: GET https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{lastPathSegment}
 * → {jobPostingInfo: {jobDescription (HTML), jobReqId, …}}. `postedOn` is
 * relative text ("Posted 30+ Days Ago") — never parsed to a date. No deadline.
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import { UnsupportedUrlError, htmlToText, politeFetch } from "@/lib/ingestion/detail/net";

const WorkdayJobSchema = z.looseObject({
  jobPostingInfo: z.looseObject({
    jobDescription: z.string(),
    jobReqId: z.string().optional(),
    title: z.string().optional(),
  }),
});

// Case-insensitive on purpose: tenants use both "en-US" and "en-us" (Intel),
// and a case-sensitive match silently treats the locale as the site name,
// producing a 404 cxs URL.
const LOCALE_RE = /^[a-z]{2}-[a-z]{2}$/i;

export async function fetchWorkdayDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const hostMatch = u.hostname.match(/^([^.]+)\.wd\d+\.myworkdayjobs\.com$/i);
  if (!hostMatch) throw new UnsupportedUrlError(`unrecognized workday host: ${url}`);
  const tenant = hostMatch[1];

  const segments = u.pathname.split("/").filter(Boolean);
  let i = 0;
  if (segments[i] !== undefined && LOCALE_RE.test(segments[i])) i++; // skip en-US style locale
  const site = segments[i];
  if (!site || segments[i + 1] !== "job" || segments.length < i + 3) {
    throw new UnsupportedUrlError(`unrecognized workday URL: ${url}`);
  }
  const slug = segments[segments.length - 1];

  const apiUrl = `${u.origin}/wday/cxs/${tenant}/${site}/job/${slug}`;
  const res = await politeFetch(apiUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "workday", raw };

  try {
    const job = WorkdayJobSchema.parse(JSON.parse(raw));
    return {
      status: "ok",
      atsKind: "workday",
      postingText: htmlToText(job.jobPostingInfo.jobDescription),
      requisitionId: job.jobPostingInfo.jobReqId,
      raw,
    };
  } catch (err) {
    ctx.log(`workday parse failed for ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "workday", raw };
  }
}
