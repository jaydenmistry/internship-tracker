/**
 * Lever. Page URL: https://jobs.lever.co/{org}/{uuid}.
 * API: GET https://api.lever.co/v0/postings/{org}/{uuid}?mode=json.
 * No deadline field. A dead posting returns 404 with
 * {"ok":false,"error":"Document not found"} → status "http_404".
 */
import { z } from "zod";
import type { DetailContext, DetailResult } from "@/lib/ingestion/detail/index";
import { UnsupportedUrlError, htmlToText, politeFetch } from "@/lib/ingestion/detail/net";

const LeverPostingSchema = z.looseObject({
  text: z.string().optional(), // title
  descriptionPlain: z.string().optional(),
  descriptionBodyPlain: z.string().optional(),
  additionalPlain: z.string().optional(),
  lists: z
    .array(z.looseObject({ text: z.string().optional(), content: z.string().optional() }))
    .optional(),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function fetchLeverDetail(url: string, ctx: DetailContext): Promise<DetailResult> {
  const u = new URL(url);
  const [org, uuid] = u.pathname.split("/").filter(Boolean);
  if (!org || !uuid || !UUID_RE.test(uuid)) {
    throw new UnsupportedUrlError(`unrecognized lever URL: ${url}`);
  }

  const apiUrl = `https://api.lever.co/v0/postings/${org}/${uuid}?mode=json`;
  const res = await politeFetch(apiUrl, ctx);
  const raw = await res.text();
  if (!res.ok) return { status: `http_${res.status}`, atsKind: "lever", raw };

  try {
    const posting = LeverPostingSchema.parse(JSON.parse(raw));
    const sections: (string | undefined)[] = [
      posting.text,
      posting.descriptionBodyPlain || posting.descriptionPlain,
      ...(posting.lists ?? []).flatMap((list) => [
        list.text,
        list.content !== undefined ? htmlToText(list.content) : undefined,
      ]),
      posting.additionalPlain,
    ];
    const postingText = sections
      .map((s) => s?.trim())
      .filter((s): s is string => !!s)
      .join("\n\n");
    if (postingText === "") return { status: "parse_failed", atsKind: "lever", raw };
    return { status: "ok", atsKind: "lever", postingText, raw };
  } catch (err) {
    ctx.log(`lever parse failed for ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`);
    return { status: "parse_failed", atsKind: "lever", raw };
  }
}
