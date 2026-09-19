/**
 * Stage 1 of scoring: pure, deterministic, entirely config-driven.
 *
 * `(listing, config, now) → { ruleScore, breakdown, disqualified, reasons }`.
 * No I/O, no Prisma, no `Date.now()` — `now` is always a parameter so tests are
 * stable. Every weight, keyword, ranking, tier and bucket comes from
 * `config/scoring.json`; nothing scoring-related is hardcoded here.
 */

import { COMPONENT_NAMES, type ComponentName, type ScoringConfig } from "@/lib/scoring/config";

/**
 * Bump whenever a change here would produce different scores for unchanged
 * input. Stored scores are keyed on config-hash + this version, so a logic
 * change triggers a rescore on the next pass instead of leaving every listing
 * on its old score. (Forgetting to bump is not fatal — the time-based
 * staleness window in rescore.ts re-scores everything within a day anyway.)
 */
export const SCORING_ENGINE_VERSION = 2;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ScoringInput {
  title: string;
  category: string | null;
  postingText: string | null;
  locations: string[];
  countries: string[];
  remote: boolean;
  degrees: string[];
  sponsorship: string | null;
  postedAt: Date | null;
  deadline: Date | null;
  likelyClosed: boolean;
  terms: string[];
  company: { name: string; faangPlus: boolean; tierOverride: number | null };
}

/**
 * Declared as a type alias, not an interface, on purpose: the breakdown is
 * persisted to a Prisma `Json` column, and only type aliases get the implicit
 * index signature that `Prisma.InputJsonValue` requires. An interface here
 * forces every caller to cast.
 */
export type ComponentScore = {
  points: number;
  max: number;
  evidence: string[];
};

export interface ScoreResult {
  /** Integer 0–100. Forced to 0 when `disqualified`, breakdown kept intact. */
  ruleScore: number;
  breakdown: Record<string, ComponentScore>;
  disqualified: boolean;
  disqualifyReasons: string[];
}

// ---------------------------------------------------------------------------
// Small helpers (pure)
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Compiled-pattern cache. Scoring ~2,800 listings against ~200 config patterns
 * otherwise recompiles the same sources hundreds of thousands of times. Purity
 * is unaffected: the regexes carry no /g flag and therefore no `lastIndex`
 * state, and the cache is keyed on the exact source string.
 */
const regexCache = new Map<string, RegExp>();

function compile(source: string): RegExp {
  let re = regexCache.get(source);
  if (re === undefined) {
    re = new RegExp(source, "i");
    regexCache.set(source, re);
  }
  return re;
}

/** First substring of `text` matched by any pattern, else null. */
function firstMatch(text: string, patterns: readonly string[]): string | null {
  for (const source of patterns) {
    const m = compile(source).exec(text);
    if (m) return m[0];
  }
  return null;
}

function matchesAny(text: string, patterns: readonly string[]): boolean {
  return firstMatch(text, patterns) !== null;
}

function quote(matched: string): string {
  return `"${matched.trim()}"`;
}

function component(points: number, max: number, evidence: string[]): ComponentScore {
  return { points: roundTo(points, 2), max: roundTo(max, 2), evidence };
}

/**
 * Split into sentence-ish chunks so an exemption only covers its own sentence.
 * A sentence break needs a capital-ish start after the period, so degree
 * abbreviations ("Ph.D. degree is required") stay in one piece. Bullet glyphs
 * — including the hyphen and asterisk bullets ATS text is full of — break a
 * chunk too, so a requirements list with no newlines does not read as one
 * sentence.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])|\n+|(?:^|\s)[•‧·*+]\s*|(?:^|\s)[-–—]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function scoreTechFit(input: ScoringInput, config: ScoringConfig): ComponentScore {
  const cfg = config.techFit;
  const usingPostingText = input.postingText !== null && input.postingText.trim() !== "";
  const haystack = usingPostingText
    ? (input.postingText as string)
    : [input.title, input.category ?? ""].join(" ");

  const evidence: string[] = [];
  let raw = 0;
  for (const skill of cfg.skills) {
    const matched = firstMatch(haystack, skill.patterns);
    if (matched === null) continue;
    raw += skill.points;
    evidence.push(`${skill.label} (${quote(matched)})`);
  }

  if (evidence.length === 0) evidence.push(cfg.noMatchNote);
  // Thin-signal listings are expected: most sources give a title and nothing else.
  if (!usingPostingText) evidence.push(cfg.titleOnlyNote);

  return component(Math.min(raw, cfg.maxPoints), cfg.maxPoints, evidence);
}

function scoreRoleType(input: ScoringInput, config: ScoringConfig): ComponentScore {
  const cfg = config.roleType;
  const titleText = [input.title, input.category ?? ""].join(" ");

  // Classes are ordered by specificity; first match wins.
  for (const klass of cfg.classes) {
    const matched = firstMatch(titleText, klass.patterns);
    if (matched === null) continue;
    return component(klass.fraction * cfg.maxPoints, cfg.maxPoints, [
      `${klass.label} (title/category matched ${quote(matched)})`,
    ]);
  }

  if (cfg.matchPostingTextWhenTitleUnmatched && input.postingText) {
    for (const klass of cfg.classes) {
      const matched = firstMatch(input.postingText, klass.patterns);
      if (matched === null) continue;
      return component(klass.fraction * cfg.maxPoints, cfg.maxPoints, [
        `${klass.label} (posting text matched ${quote(matched)})`,
      ]);
    }
  }

  return component(cfg.unmatched.fraction * cfg.maxPoints, cfg.maxPoints, [cfg.unmatched.label]);
}

function scoreCompanyTier(input: ScoringInput, config: ScoringConfig): ComponentScore {
  const cfg = config.companyTier;
  const { faangPlus, tierOverride } = input.company;

  let tier: number;
  let source: string;
  if (tierOverride !== null) {
    tier = tierOverride;
    source = "manual tier override";
  } else if (faangPlus) {
    tier = cfg.faangPlusTier;
    source = "FAANG+ flag";
  } else {
    tier = cfg.defaultTier;
    source = "default tier";
  }

  const entry = cfg.tiers.find((t) => t.tier === tier);
  if (!entry) {
    return component(cfg.unknownTierFraction * cfg.maxPoints, cfg.maxPoints, [
      `tier ${tier} not defined in config (${source})`,
    ]);
  }
  return component(entry.fraction * cfg.maxPoints, cfg.maxPoints, [`${entry.label} — ${source}`]);
}

function scoreLocation(input: ScoringInput, config: ScoringConfig): ComponentScore {
  const cfg = config.location;
  const usCodes = new Set(cfg.usCountryCodes.map((c) => c.toUpperCase()));
  const countries = input.countries.map((c) => c.toUpperCase());
  const hasUs = countries.some((c) => usCodes.has(c));
  const unknownCountry = countries.length === 0;

  const candidates: Array<{ fraction: number; evidence: string }> = [];

  if (input.remote && (hasUs || unknownCountry)) {
    candidates.push({ fraction: cfg.remote.fraction, evidence: cfg.remote.label });
  }

  for (const loc of input.locations) {
    const home = firstMatch(loc, cfg.homeMetro.patterns);
    if (home !== null) {
      candidates.push({ fraction: cfg.homeMetro.fraction, evidence: `${cfg.homeMetro.label} — ${loc}` });
      continue;
    }
    const hub = firstMatch(loc, cfg.hubs.patterns);
    if (hub !== null) {
      candidates.push({ fraction: cfg.hubs.fraction, evidence: `${cfg.hubs.label} — ${loc}` });
      continue;
    }
    if (hasUs || unknownCountry) {
      candidates.push({ fraction: cfg.restOfUs.fraction, evidence: `${cfg.restOfUs.label} — ${loc}` });
    } else {
      candidates.push({ fraction: cfg.nonUs.fraction, evidence: `${cfg.nonUs.label} — ${loc}` });
    }
  }

  if (candidates.length === 0) {
    return component(cfg.unknown.fraction * cfg.maxPoints, cfg.maxPoints, [cfg.unknown.label]);
  }

  let best = candidates[0];
  for (const candidate of candidates) {
    if (candidate.fraction > best.fraction) best = candidate;
  }
  return component(best.fraction * cfg.maxPoints, cfg.maxPoints, [best.evidence]);
}

function scoreFreshness(input: ScoringInput, config: ScoringConfig, now: Date): ComponentScore {
  const cfg = config.freshness;
  if (input.postedAt === null) {
    return component(cfg.missingPostedAtFraction * cfg.maxPoints, cfg.maxPoints, [
      cfg.missingPostedAtLabel,
    ]);
  }
  const ageDays = Math.max(0, (now.getTime() - input.postedAt.getTime()) / MS_PER_DAY);
  const fraction = Math.pow(0.5, ageDays / cfg.halfLifeDays);
  return component(fraction * cfg.maxPoints, cfg.maxPoints, [
    `posted ${roundTo(ageDays, 1)}d ago (half-life ${cfg.halfLifeDays}d)`,
  ]);
}

function scoreDeadlineUrgency(
  input: ScoringInput,
  config: ScoringConfig,
  now: Date,
): ComponentScore {
  const cfg = config.deadlineUrgency;
  if (input.deadline === null) {
    return component(cfg.missingFraction * cfg.maxPoints, cfg.maxPoints, ["no deadline given"]);
  }
  const daysLeft = (input.deadline.getTime() - now.getTime()) / MS_PER_DAY;
  if (daysLeft < 0) {
    // A past deadline is not urgency; closed-ness is the disqualifier's job.
    return component(cfg.pastFraction * cfg.maxPoints, cfg.maxPoints, [
      `deadline passed ${roundTo(-daysLeft, 1)}d ago`,
    ]);
  }
  if (daysLeft <= cfg.windowDays) {
    return component(cfg.inWindowFraction * cfg.maxPoints, cfg.maxPoints, [
      `closes in ${roundTo(daysLeft, 1)}d (within ${cfg.windowDays}d window)`,
    ]);
  }
  return component(cfg.outsideWindowFraction * cfg.maxPoints, cfg.maxPoints, [
    `closes in ${roundTo(daysLeft, 1)}d (outside ${cfg.windowDays}d window)`,
  ]);
}

// ---------------------------------------------------------------------------
// Disqualifiers
// ---------------------------------------------------------------------------

function advancedDegreeReasons(input: ScoringInput, config: ScoringConfig): string[] {
  const cfg = config.disqualifiers.advancedDegrees;
  const reasons: string[] = [];

  // 1. Structured degrees[]. Sources list the degrees a posting ACCEPTS, so a
  //    bachelor-level entry means undergrads qualify — not a disqualifier.
  const bachelorsAccepted =
    cfg.bachelorsExempt && input.degrees.some((d) => matchesAny(d, cfg.bachelorPatterns));
  if (bachelorsAccepted) {
    // Structured source data saying undergrads are accepted outranks any regex
    // over prose, so the posting-text pass below is skipped entirely too.
    return reasons;
  }

  for (const degree of input.degrees) {
    for (const rule of cfg.degrees) {
      if (matchesAny(degree, rule.patterns) && !reasons.includes(rule.reason)) {
        reasons.push(rule.reason);
      }
    }
  }

  // 2. Posting text, evaluated sentence by sentence so an exemption
  //    ("Bachelor's or Master's degree") only covers its own sentence.
  if (input.postingText) {
    for (const sentence of sentences(input.postingText)) {
      if (matchesAny(sentence, cfg.textExemptPatterns)) continue;
      for (const rule of cfg.textPatterns) {
        if (new RegExp(rule.pattern, "i").test(sentence) && !reasons.includes(rule.reason)) {
          reasons.push(rule.reason);
        }
      }
    }
  }

  return reasons;
}

function workAuthorizationReason(input: ScoringInput, config: ScoringConfig): string | null {
  const cfg = config.disqualifiers.workAuthorization;
  if (input.countries.length === 0) return null;
  if (cfg.remoteExempt && input.remote) return null;
  const blocked = new Set(cfg.blockedCountries.map((c) => c.toUpperCase()));
  const allBlocked = input.countries.every((c) => blocked.has(c.toUpperCase()));
  return allBlocked ? cfg.reason : null;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Score one listing. Disqualified listings keep their full breakdown (hiding
 * them is a UI toggle) but get `ruleScore` 0.
 *
 * ruleScore = round(100 × Σ(weightᵢ × pointsᵢ/maxᵢ) / Σ weightᵢ).
 * A weight missing from the config counts as 0.
 */
export function scoreListing(
  input: ScoringInput,
  config: ScoringConfig,
  now: Date,
): ScoreResult {
  const breakdown: Record<ComponentName, ComponentScore> = {
    techFit: scoreTechFit(input, config),
    roleType: scoreRoleType(input, config),
    companyTier: scoreCompanyTier(input, config),
    location: scoreLocation(input, config),
    freshness: scoreFreshness(input, config, now),
    deadlineUrgency: scoreDeadlineUrgency(input, config, now),
  };

  const disqualifyReasons: string[] = [...advancedDegreeReasons(input, config)];
  const authReason = workAuthorizationReason(input, config);
  if (authReason) disqualifyReasons.push(authReason);
  if (input.likelyClosed) disqualifyReasons.push(config.disqualifiers.closed.reason);

  let weightSum = 0;
  let weighted = 0;
  for (const name of COMPONENT_NAMES) {
    const weight = config.weights[name] ?? 0;
    if (weight <= 0) continue;
    const { points, max } = breakdown[name];
    weightSum += weight;
    weighted += weight * (max > 0 ? points / max : 0);
  }

  const normalized = weightSum > 0 ? (100 * weighted) / weightSum : 0;
  const ruleScore = disqualifyReasons.length > 0
    ? 0
    : Math.max(0, Math.min(100, Math.round(normalized)));

  return {
    ruleScore,
    breakdown,
    disqualified: disqualifyReasons.length > 0,
    disqualifyReasons,
  };
}
