/**
 * Oracle Cloud HCM ("Candidate Experience"). Page URL:
 *   https://{pod}.oraclecloud.com/hcmUI/CandidateExperience/{lang}/sites/{site}/job/{id}
 * The page is a client-rendered app with no text in its HTML, which is why
 * the generic fallback failed on every one of these. Its own REST endpoint is
 * public:
 *   GET https://{pod}.oraclecloud.com/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails
 *       ?expand=all&onlyData=true&finder=ById;Id="{id}",siteNumber={site}
 * → {items: [{Title, ExternalDescriptionStr, ExternalResponsibilitiesStr,
 *   ExternalQualificationsStr, CorporateDescriptionStr, ExternalPostedEndDate}]}
 * (HTML strings). An empty `items` means the requisition is no longer posted.
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import { UnsupportedUrlError, htmlToText, parseDateMaybe, politeFetch } from "@/lib/ingestion/detail/net";

const html = z.string().nullish();

const OracleResponseSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      Id: z.union([z.string(), z.number()]).nullish(),
      Title: z.string().nullish(),
      ExternalDescriptionStr: html,
      ExternalResponsibilitiesStr: html,
      ExternalQualificationsStr: html,
      CorporateDescriptionStr: html,
      ExternalPostedEndDate: z.string().nullish(),
    }),
  ),
});

const PATH_RE = /\/hcmUI\/CandidateExperience\/[^/]+\/sites\/([^/]+)\/(?:job|requisitions\/preview)\/(\d+)/i;

export function isOracleCandidateExperience(u: URL): boolean {
  return u.hostname.toLowerCase().endsWith(".oraclecloud.com") && PATH_RE.test(u.pathname);
}

export async function fetchOracleDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const match = u.pathname.match(PATH_RE);
  if (!match) throw new UnsupportedUrlError(`unrecognized Oracle Cloud URL: ${url}`);
  const [, site, id] = match;

  // Both values are matched as [^/]+ and \d+ above; the site still goes
  // through encodeURIComponent so it can't add a finder parameter.
  const apiUrl =
    `${u.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails` +
    `?expand=all&onlyData=true&finder=ById;Id=%22${id}%22,siteNumber=${encodeURIComponent(site)}`;
  const res = await politeFetch(apiUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "oracle", raw };

  try {
    const body = OracleResponseSchema.parse(JSON.parse(raw));
    const job = body.items[0];
    if (!job) return { status: "gone", atsKind: "oracle", raw };
    // The role first; the employer's boilerplate last, so a truncated copy
    // (the Claude pass reads the first few thousand characters) keeps the job.
    const postingText = [
      job.ExternalDescriptionStr,
      job.ExternalResponsibilitiesStr,
      job.ExternalQualificationsStr,
      job.CorporateDescriptionStr,
    ]
      .map((part) => (part ? htmlToText(part) : ""))
      .filter(Boolean)
      .join("\n\n");
    if (postingText === "") return { status: "parse_failed", atsKind: "oracle", raw };
    return {
      status: "ok",
      atsKind: "oracle",
      postingText,
      deadline: parseDateMaybe(job.ExternalPostedEndDate),
      requisitionId: job.Id != null ? String(job.Id) : id,
      raw,
    };
  } catch (err) {
    ctx.log(`oracle parse failed for ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "oracle", raw };
  }
}
