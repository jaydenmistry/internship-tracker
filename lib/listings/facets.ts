/**
 * Pure helpers that turn source fields into the values the table filters on.
 * Kept free of Prisma so client components can import them.
 */

/**
 * Sources name the same category differently: Simplify says "Software",
 * intern-list (jobright) says "Software Engineering". The filter offers one
 * option per group, so both spellings land on Simplify's shorter name.
 */
const CATEGORY_GROUPS: Array<[group: string, pattern: RegExp]> = [
  ["AI/ML/Data", /\b(?:ai|ml|machine learning|data)\b/i],
  ["Quant", /\bquant/i],
  ["Hardware", /\bhardware\b/i],
  ["Product", /\bproduct\b/i],
  ["Software", /\bsoftware\b/i],
];

export function categoryGroup(category: string | null | undefined): string | null {
  const trimmed = category?.trim();
  if (!trimmed) return null;
  for (const [group, pattern] of CATEGORY_GROUPS) {
    if (pattern.test(trimmed)) return group;
  }
  return trimmed;
}

/** Terms as the filter lists them: "N/A" and blanks dropped, duplicates removed. */
export function cleanTerms(terms: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const term = raw.trim();
    if (!term || /^n\/?a$/i.test(term) || out.includes(term)) continue;
    out.push(term);
  }
  return out;
}

const SEASON_ORDER: Record<string, number> = { winter: 0, spring: 1, summer: 2, fall: 3 };

/** "Summer 2027" → a sortable number; anything unrecognised sorts last, by name. */
export function termSortKey(term: string): number {
  const m = /^(winter|spring|summer|fall)\s+(\d{4})$/i.exec(term.trim());
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[2]) * 10 + SEASON_ORDER[m[1].toLowerCase()];
}

export function compareTerms(a: string, b: string): number {
  return termSortKey(a) - termSortKey(b) || a.localeCompare(b);
}
