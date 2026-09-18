import { createHash } from "node:crypto";
import { load } from "cheerio";
import {
  NormalizedListingSchema,
  type AdapterResult,
  type FetchContext,
  type NormalizedListing,
  type SourceAdapter,
} from "./types";

/**
 * Simplify (SimplifyJobs/Summer2027-Internships) adapter.
 *
 * Primary source: `.github/scripts/listings.json` on the `dev` branch — a JSON
 * array of listing objects. We keep entries whose `terms` include
 * "Summer 2027" and that are `is_visible`, INCLUDING `active === false` ones
 * (the pipeline needs those for likely-closed detection).
 *
 * The FAANG+ (🔥) marker exists only in the README, so a light second pass
 * extracts the 🔥 company-name set from the README's HTML tables. A README
 * fetch failure never fails the adapter — we just proceed without the flag.
 *
 * Fallback (only when listings.json returns non-200 or unparseable JSON):
 * parse the README's HTML tables directly.
 */

const LISTINGS_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json";
const README_URL =
  "https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md";

const SOURCE_ID = "simplify";
const TARGET_TERM = "Summer 2027";

/** README legend markers. 🔥 lives on the company cell; the rest on role/company text. */
const MARKER_FAANG = "🔥";
const MARKER_CLOSED = "🔒";
const MARKER_NO_SPONSORSHIP = "🛂";
const MARKER_CITIZENSHIP = "🇺🇸";
const MARKER_ADVANCED_DEGREE = "🎓";
const MARKER_STRIP_RE = /🔥|🔒|🛂|🇺🇸|🎓/gu;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Case/whitespace-insensitive company-name key for FAANG+ matching. */
function companyKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function unixSecondsToDate(value: unknown): Date | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? new Date(value * 1000)
    : undefined;
}

/** The S27 + visibility filter. Inactive entries are deliberately kept. */
function isWanted(entry: unknown): entry is Dict {
  return (
    isDict(entry) &&
    Array.isArray(entry.terms) &&
    entry.terms.includes(TARGET_TERM) &&
    entry.is_visible === true
  );
}

/**
 * Extract the set of 🔥 (FAANG+) company names from the README. Companies sit
 * in table cells as anchor text; the legend line ("- 🔥 FAANG+ company") is
 * plain markdown, not a table cell, so it is naturally excluded.
 * Returns names as written; callers compare via {@link companyKey}.
 */
export function extractFaangCompanies(readmeHtml: string): Set<string> {
  const $ = load(readmeHtml);
  const names = new Set<string>();
  $("td").each((_, td) => {
    const cell = $(td);
    if (!cell.text().includes(MARKER_FAANG)) return;
    const anchor = cell.find('a[href*="simplify.jobs/c/"]').first();
    const name = (anchor.length > 0 ? anchor : cell.find("a").first())
      .text()
      .trim();
    if (name) names.add(name);
  });
  return names;
}

/** Map one raw listings.json entry to a NormalizedListing candidate. */
function toCandidate(entry: Dict, faangKeys: Set<string>): unknown {
  const company =
    typeof entry.company_name === "string"
      ? entry.company_name.trim()
      : entry.company_name;
  const title = typeof entry.title === "string" ? entry.title.trim() : entry.title;
  return {
    source: SOURCE_ID,
    sourceUid: entry.id,
    company,
    title,
    // Some URLs contain unicode escapes / query junk — pass through as-is.
    url: entry.url,
    locations: entry.locations,
    category: entry.category,
    terms: entry.terms,
    sponsorship: entry.sponsorship === "Other" ? undefined : entry.sponsorship,
    degrees: entry.degrees,
    postedAt: unixSecondsToDate(entry.date_posted),
    updatedAt: unixSecondsToDate(entry.date_updated),
    active: entry.active,
    companyFaangPlus:
      typeof company === "string" && faangKeys.has(companyKey(company)),
    raw: entry,
  };
}

function parseListingsJson(
  entries: unknown[],
  readmeText: string | undefined,
  ctx: FetchContext,
): NormalizedListing[] {
  let faangKeys = new Set<string>();
  if (readmeText !== undefined) {
    faangKeys = new Set(
      [...extractFaangCompanies(readmeText)].map((name) => companyKey(name)),
    );
  }

  const listings: NormalizedListing[] = [];
  let skipped = 0;
  let firstError: string | undefined;
  for (const entry of entries) {
    if (!isWanted(entry)) continue;
    const result = NormalizedListingSchema.safeParse(toCandidate(entry, faangKeys));
    if (result.success) {
      listings.push(result.data);
    } else {
      skipped += 1;
      firstError ??= result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");
    }
  }
  if (skipped > 0) {
    ctx.log(
      `simplify: skipped ${skipped} entr${skipped === 1 ? "y" : "ies"} failing validation (first error: ${firstError})`,
    );
  }
  return listings;
}

/**
 * FALLBACK parser: the README's HTML tables. Rows carry company (anchor text,
 * 🔥 prefix possible), role title, location(s) split by <br>, an application
 * link, and marker emojis. Company continuation rows (↳) inherit the previous
 * company. sourceUid = sha256 of the application URL.
 */
export function parseReadmeTables(
  readmeHtml: string,
  ctx: FetchContext,
): NormalizedListing[] {
  const $ = load(readmeHtml);
  const listings: NormalizedListing[] = [];
  let skipped = 0;
  let current: { company: string; faang: boolean } | undefined;

  $("tr").each((_, tr) => {
    const tds = $(tr).children("td");
    if (tds.length < 4) return; // header rows, or orphaned cell fragments

    const companyCell = tds.eq(0);
    const companyCellText = companyCell.text().trim();
    let company: string;
    let faang: boolean;
    if (companyCellText.startsWith("↳")) {
      if (!current) return;
      ({ company, faang } = current);
    } else {
      const anchorText = companyCell.find("a").first().text().trim();
      company =
        anchorText ||
        companyCellText.replace(MARKER_STRIP_RE, "").replace(/\s+/g, " ").trim();
      if (!company) return;
      faang = companyCellText.includes(MARKER_FAANG);
      current = { company, faang };
    }

    const roleRaw = tds.eq(1).text().trim();
    const title = roleRaw.replace(MARKER_STRIP_RE, "").replace(/\s+/g, " ").trim();
    if (!title) return;

    const markerText = `${companyCellText} ${roleRaw}`;
    const active = !markerText.includes(MARKER_CLOSED);
    // Conservative stand-in: the README only says "advanced degree required".
    const degrees = markerText.includes(MARKER_ADVANCED_DEGREE) ? ["Master's"] : [];
    let sponsorship: string | undefined;
    if (markerText.includes(MARKER_NO_SPONSORSHIP)) {
      sponsorship = "Does Not Offer Sponsorship";
    } else if (markerText.includes(MARKER_CITIZENSHIP)) {
      sponsorship = "U.S. Citizenship is Required";
    }

    const locationCell = tds.eq(2);
    locationCell.find("br").replaceWith("\n");
    const locations = locationCell
      .text()
      .split("\n")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const hrefs = tds
      .eq(3)
      .find("a[href]")
      .toArray()
      .map((a) => $(a).attr("href"))
      .filter((href): href is string => typeof href === "string" && href.length > 0);
    // The apply link comes first; the trailing anchor is the simplify.jobs/p/ card.
    const url = hrefs.find((href) => !href.includes("simplify.jobs/p/")) ?? hrefs[0];
    if (url === undefined) return;

    const result = NormalizedListingSchema.safeParse({
      source: SOURCE_ID,
      sourceUid: createHash("sha256").update(url).digest("hex"),
      company,
      title,
      url,
      locations,
      terms: [TARGET_TERM],
      sponsorship,
      degrees,
      active,
      companyFaangPlus: faang,
      raw: $.html(tr),
    });
    if (result.success) {
      listings.push(result.data);
    } else {
      skipped += 1;
    }
  });

  if (skipped > 0) {
    ctx.log(`simplify: fallback skipped ${skipped} README rows failing validation`);
  }
  return listings;
}

export const simplifyAdapter: SourceAdapter = {
  id: SOURCE_ID,
  displayName: "Simplify (Summer 2027 Internships)",

  async fetch(ctx: FetchContext): Promise<AdapterResult> {
    const headers = { "User-Agent": ctx.userAgent };

    // Raw payload is captured BEFORE parsing so parser breakage stays debuggable.
    const listingsResponse = await ctx.fetch(LISTINGS_URL, { headers });
    const listingsText = await listingsResponse.text();
    if (listingsResponse.ok) await ctx.saveRaw?.(listingsText);
    let entries: unknown[] | undefined;
    if (listingsResponse.ok) {
      try {
        const parsed: unknown = JSON.parse(listingsText);
        if (Array.isArray(parsed)) {
          entries = parsed;
        } else {
          ctx.log("simplify: listings.json parsed but is not an array — falling back to README");
        }
      } catch {
        ctx.log("simplify: listings.json is unparseable JSON — falling back to README");
      }
    } else {
      ctx.log(
        `simplify: listings.json returned HTTP ${listingsResponse.status} — falling back to README`,
      );
    }

    // The README is needed either way: FAANG+ 🔥 pass (primary) or table
    // parsing (fallback). In the primary path its failure must not fail us.
    let readmeText: string | undefined;
    try {
      const readmeResponse = await ctx.fetch(README_URL, { headers });
      if (readmeResponse.ok) {
        readmeText = await readmeResponse.text();
      } else {
        ctx.log(
          `simplify: README fetch returned HTTP ${readmeResponse.status}; proceeding without FAANG+ flags`,
        );
      }
    } catch (error) {
      ctx.log(
        `simplify: README fetch failed (${error instanceof Error ? error.message : String(error)}); proceeding without FAANG+ flags`,
      );
    }

    if (entries !== undefined) {
      return {
        listings: parseListingsJson(entries, readmeText, ctx),
        rawPayload: listingsText,
      };
    }

    // Fallback path: README tables are the only remaining source of truth.
    if (readmeText === undefined) {
      throw new Error(
        "simplify: listings.json unusable and README unavailable — nothing to parse",
      );
    }
    ctx.log("simplify: using README table fallback parser");
    await ctx.saveRaw?.(readmeText);
    return {
      listings: parseReadmeTables(readmeText, ctx),
      rawPayload: readmeText,
    };
  },
};
