/**
 * Pure normalization helpers for the ingestion pipeline.
 *
 * No I/O, no network, no DB, no Date.now() — every function is deterministic
 * over its arguments so the dedup logic stays trivially testable.
 */

// ---------------------------------------------------------------------------
// Company
// ---------------------------------------------------------------------------

/** Legal suffixes stripped (repeatedly) from the END of a company name. */
const LEGAL_SUFFIXES = new Set([
  "inc",
  "incorporated",
  "llc",
  "ltd",
  "limited",
  "corp",
  "corporation",
  "co",
  "company",
  "plc",
  "gmbh",
]);

/**
 * Lowercase, strip punctuation, collapse whitespace, and strip trailing legal
 * suffixes ("Ramp, Inc." → "ramp"). Intentionally does NOT fold synonyms
 * (technologies ≠ tech) — only suffix + punctuation cleanup.
 */
export function normalizeCompany(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(" ");
}

// ---------------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------------

/**
 * Lowercase and strip noise that varies between postings of the same role:
 * parenthetical/bracketed qualifiers, season+year tokens, standalone years,
 * req-id-looking tokens (R260002319, REQ-24832, JR12345, J00171081, 2027-40012),
 * and duration tokens ("10 weeks"). "co-op"/"coop"/"co op" collapse to "co-op".
 * No aggressive synonym folding: "swe", "sw engineer", "software engineer"
 * stay distinct.
 */
export function normalizeTitle(title: string): string {
  let t = title.toLowerCase();
  // Unify co-op spellings before punctuation handling so the hyphen survives.
  t = t.replace(/\bco[\s-]?op\b/g, "co-op");
  // Bracketed / parenthesized qualifiers.
  t = t.replace(/\([^)]*\)/g, " ").replace(/\[[^\]]*\]/g, " ");
  // Req-id-looking tokens (before year stripping so "2027-40012" is caught whole).
  t = t.replace(/\b(?:req[-\s]?\d+|r\d{6,}(?:-\d+)?|jr\d{4,}|j\d{6,}|20\d{2}-\d{2,})\b/g, " ");
  // Season (+ optional year) and standalone year tokens.
  t = t.replace(/\b(?:summer|fall|autumn|spring|winter)\s*(?:of\s*)?(?:20\d{2})?\b/g, " ");
  t = t.replace(/\b20\d{2}\b/g, " ");
  // Duration noise: "10 weeks", "12-week".
  t = t.replace(/\b\d+\s*-?\s*weeks?\b/g, " ");
  // Punctuation → space, keeping intra-word hyphens (co-op).
  t = t.replace(/[^a-z0-9-]+/g, " ");
  // Standalone or dangling hyphens left behind by the removals above.
  t = t.replace(/(?:^|\s)-+|-+(?=\s|$)/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One stable slug per listing for the dedup key. Remote → "remote"; else the
 * first parseable location: "City, ST" → "city-st", "City, Country" →
 * "city-country" ("Toronto, ON, Canada" uses the first two parts →
 * "toronto-on"); nothing parseable → "unknown".
 */
export function locationBucket(locations: string[], remote: boolean): string {
  if (remote) return "remote";
  for (const loc of locations) {
    const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const city = slugify(parts[0]);
      const region = slugify(parts[1]);
      if (city && region) return `${city}-${region}`;
    }
    if (parts.length === 1 && /^remote$/i.test(parts[0])) return "remote";
  }
  return "unknown";
}

const US_STATES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
  "DC",
]);

const CA_PROVINCES = new Set([
  "ON", "BC", "QC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU",
]);

/** Cities recognizable as Canadian when no region code/country is present. */
const CA_CITIES = new Set([
  "toronto", "vancouver", "montreal", "ottawa", "waterloo", "calgary", "edmonton", "mississauga",
]);

const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  canada: "CA",
  "united kingdom": "UK",
  uk: "UK",
  england: "UK",
  scotland: "UK",
  germany: "DE",
  france: "FR",
  ireland: "IE",
  netherlands: "NL",
  "the netherlands": "NL",
  spain: "ES",
  italy: "IT",
  poland: "PL",
  sweden: "SE",
  denmark: "DK",
  finland: "FI",
  norway: "NO",
  portugal: "PT",
  belgium: "BE",
  austria: "AT",
  switzerland: "CH",
  "czech republic": "CZ",
  czechia: "CZ",
  romania: "RO",
  hungary: "HU",
};

function countryOfLocation(loc: string): string | null {
  const trimmed = loc.trim();
  if (/^remote(\s+in\s+(the\s+)?(usa?|united states))?$/i.test(trimmed)) return "US";
  const parts = trimmed.split(",").map((p) => p.trim()).filter(Boolean);
  // Scan from the most specific end (country / region code) backwards.
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    const named = COUNTRY_NAMES[part.toLowerCase()];
    if (named) return named;
    if (/^[A-Za-z]{2}$/.test(part)) {
      const code = part.toUpperCase();
      if (US_STATES.has(code)) return "US";
      if (CA_PROVINCES.has(code)) return "CA";
    }
  }
  // City-only fallback (e.g. "Toronto").
  if (parts.length > 0 && CA_CITIES.has(parts[0].toLowerCase())) return "CA";
  return null;
}

/**
 * ISO-ish country labels derived from location strings. US state codes → "US",
 * Canadian provinces/cities → "CA", UK patterns → "UK", recognizable EU country
 * names → their code. A bare "Remote" (or remote flag with nothing else
 * derivable) → ["US"] — this app's context is US-remote. Deduped, insertion
 * order.
 */
export function deriveCountries(locations: string[], remote: boolean): string[] {
  const out = new Set<string>();
  for (const loc of locations) {
    const c = countryOfLocation(loc);
    if (c) out.add(c);
  }
  if (out.size === 0 && remote) out.add("US");
  return [...out];
}

// ---------------------------------------------------------------------------
// Dedup key
// ---------------------------------------------------------------------------

/** `normalizedCompany|normalizedTitle|locationBucket` — indexed, NOT unique. */
export function buildDedupKey(
  company: string,
  title: string,
  locations: string[],
  remote: boolean,
): string {
  return `${normalizeCompany(company)}|${normalizeTitle(title)}|${locationBucket(locations, remote)}`;
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

/** Tracking params dropped by canonicalizeUrl (plus any utm_* prefix). */
const TRACKING_PARAMS = new Set(["fbclid", "gclid", "gh_src", "ref", "source", "lever-source"]);

/**
 * Lowercase scheme+host, strip default ports, drop the fragment and tracking
 * params (utm_*, fbclid, gclid, gh_src, ref, source, lever-source), keep every
 * other query param in original order (gh_jid is meaningful — kept), and strip
 * the trailing slash from the path (root "/" is kept). Invalid URL → input
 * unchanged.
 */
export function canonicalizeUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  const params = new URLSearchParams(u.search);
  for (const key of [...new Set(params.keys())]) {
    const k = key.toLowerCase();
    if (k.startsWith("utm_") || TRACKING_PARAMS.has(k)) params.delete(key);
  }
  const search = params.toString();
  let pathname = u.pathname;
  if (pathname.length > 1) pathname = pathname.replace(/\/+$/, "") || "/";
  // URL already lowercases protocol/hostname and drops scheme-default ports.
  return `${u.protocol}//${u.host}${pathname}${search ? `?${search}` : ""}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Workday req token after the final underscore, e.g. R260002319-1, REQ-24832. */
const WORKDAY_REQ_RE = /^(?:r-?\d+|req-?\d+|jr\d+|j\d+)(?:-\d+)?$/i;

/**
 * Extract a requisition id from known ATS URL shapes; anything else → null.
 * Workday tokens are returned VERBATIM including any trailing posting-instance
 * suffix (e.g. "R260002319-1", not "R260002319") so two distinct Workday
 * postings never collide.
 */
export function extractRequisitionId(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const segments = u.pathname.split("/").filter(Boolean);

  // Workday: trailing _R123456 / _REQ-24832 / _JR12345 / _J00171081 on the last segment.
  if (host.endsWith(".myworkdayjobs.com")) {
    const last = segments[segments.length - 1] ?? "";
    const idx = last.lastIndexOf("_");
    if (idx !== -1) {
      const token = last.slice(idx + 1);
      if (WORKDAY_REQ_RE.test(token)) return token;
    }
    return null;
  }

  // Greenhouse: boards.greenhouse.io/{board}/jobs/{id} (or job-boards.greenhouse.io).
  if (host === "greenhouse.io" || host.endsWith(".greenhouse.io")) {
    const m = u.pathname.match(/\/jobs\/(\d+)/);
    return m ? m[1] : null;
  }

  // Lever: jobs.lever.co/{org}/{uuid}.
  if (host === "jobs.lever.co") {
    for (const s of segments) if (UUID_RE.test(s)) return s.toLowerCase();
    return null;
  }

  // Ashby: jobs.ashbyhq.com/{org}/{uuid}[/application].
  if (host === "jobs.ashbyhq.com") {
    for (const s of segments) if (UUID_RE.test(s)) return s.toLowerCase();
    return null;
  }

  // AMD-style careers site: careers.*/jobs/{digits}.
  if (host.startsWith("careers.")) {
    const m = u.pathname.match(/\/jobs\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  // iCIMS: *.icims.com/jobs/{digits}/...
  if (host.endsWith(".icims.com")) {
    const m = u.pathname.match(/\/jobs\/(\d+)(?:\/|$)/);
    return m ? m[1] : null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Title similarity
// ---------------------------------------------------------------------------

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** 1 - distance/maxLen, in 0..1. */
function levRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Two tokens count as the same word when at least this similar (engineer ~ engineering). */
const TOKEN_MATCH_RATIO = 0.7;

/**
 * Similarity of two titles in 0..1, computed over their normalized forms.
 *
 * Choice (documented): the MINIMUM of
 *   (a) fuzzy token-set Jaccard — tokens pair up when identical or with
 *       char-level ratio ≥ 0.7, so "engineer"/"engineering" match while
 *       "software"/"hardware" (ratio 0.5) do not; and
 *   (b) normalized Levenshtein over the SORTED, joined token strings (sorting
 *       makes word order irrelevant).
 * The minimum is deliberate: a plain max/blend scores "Software Engineer
 * Intern" vs "Hardware Engineer Intern" too high, because whole-string
 * Levenshtein barely notices a one-word substitution. Taking the min keeps
 * that pair at its Jaccard of 0.5 while morphological variants
 * ("Engineer"/"Engineering") still score ≈0.89. Conservative by design — a
 * wrong merge silently hides a real listing.
 *
 * Guarantees: identical normalized titles → 1.0; either side normalizing to
 * empty (and not both) → 0.
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return 1;
  if (!na || !nb) return 0;

  const tokensA = [...new Set(na.split(" "))];
  const tokensB = [...new Set(nb.split(" "))];

  // Greedy fuzzy token pairing.
  const used = new Set<number>();
  let matches = 0;
  for (const t of tokensA) {
    let bestIdx = -1;
    let best = 0;
    for (let i = 0; i < tokensB.length; i++) {
      if (used.has(i)) continue;
      const r = t === tokensB[i] ? 1 : levRatio(t, tokensB[i]);
      if (r > best) {
        best = r;
        bestIdx = i;
      }
    }
    if (bestIdx !== -1 && best >= TOKEN_MATCH_RATIO) {
      used.add(bestIdx);
      matches++;
    }
  }
  const union = tokensA.length + tokensB.length - matches;
  const jaccard = union === 0 ? 1 : matches / union;

  const sortedLev = levRatio([...tokensA].sort().join(" "), [...tokensB].sort().join(" "));
  return Math.min(jaccard, sortedLev);
}
