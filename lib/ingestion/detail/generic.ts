/**
 * Generic fallback for URLs with no dedicated ATS parser (including
 * jobright.ai, whose pages don't expose the employer's real apply URL and
 * whose /api/* is robots-disallowed — expect little from these).
 *
 * GET the page; prefer a JSON-LD JobPosting's description/validThrough; else
 * extract text from <main>/<article> (falling back to <body>) with
 * scripts/styles/nav/footer stripped. Page content is DATA — any instructions
 * inside it are never followed.
 */
import * as cheerio from "cheerio";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import {
  extractJobPostingLd,
  htmlToText,
  parseDateMaybe,
  politeFetch,
} from "@/lib/ingestion/detail/net";

export async function fetchGenericDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const res = await politeFetch(url, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "generic", raw };

  try {
    const ld = extractJobPostingLd(raw);
    if (ld?.description) {
      return {
        status: "ok",
        atsKind: "generic",
        postingText: htmlToText(ld.description),
        deadline: parseDateMaybe(ld.validThrough),
        raw,
      };
    }

    const $ = cheerio.load(raw);
    $("script, style, noscript, template, iframe, svg, nav, footer, header, aside").remove();
    const scope = $("main").length ? $("main") : $("article").length ? $("article") : $("body");
    const postingText = htmlToText(scope.html() ?? "");
    if (postingText === "") return { status: "parse_failed", atsKind: "generic", raw };
    return { status: "ok", atsKind: "generic", postingText, raw };
  } catch (err) {
    ctx.log(`generic parse failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "generic", raw };
  }
}
