/**
 * Loads and content-hashes `config/scoring.json`.
 *
 * Settled decision: the file is read and hashed on EVERY scoring run — never
 * cached at module load — so editing weights needs no restart, and a hash
 * change is what triggers a rescore of every listing. The only I/O in the
 * scoring package lives here, and it is injectable so tests stay hermetic.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** A regex source string, compiled case-insensitively by the engine. */
const PatternSchema = z.string().min(1).refine(
  (src) => {
    try {
      new RegExp(src, "i");
      return true;
    } catch {
      return false;
    }
  },
  { message: "not a valid regular expression" },
);

const PatternsSchema = z.array(PatternSchema).min(1);

const FractionSchema = z.number().min(0).max(1);

const SkillSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  points: z.number().min(0),
  patterns: PatternsSchema,
});

const RoleClassSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  fraction: FractionSchema,
  patterns: PatternsSchema,
});

const BucketSchema = z.object({
  fraction: FractionSchema,
  label: z.string().min(1),
});

const PatternBucketSchema = BucketSchema.extend({ patterns: PatternsSchema });

/**
 * Component weights. Every key is OPTIONAL: a missing weight means "this
 * component does not count" (weight 0) rather than a load failure, so the
 * config stays editable without knowing the full key set.
 */
export const WeightsSchema = z.object({
  techFit: z.number().min(0).optional(),
  roleType: z.number().min(0).optional(),
  companyTier: z.number().min(0).optional(),
  location: z.number().min(0).optional(),
  freshness: z.number().min(0).optional(),
  deadlineUrgency: z.number().min(0).optional(),
});

export const ScoringConfigSchema = z.object({
  version: z.number().int().min(1),
  /** Free-form documentation lines; ignored by the engine. */
  notes: z.array(z.string()).optional(),
  weights: WeightsSchema,
  techFit: z.object({
    maxPoints: z.number().positive(),
    titleOnlyNote: z.string().min(1),
    noMatchNote: z.string().min(1),
    skills: z.array(SkillSchema).min(1),
  }),
  roleType: z.object({
    maxPoints: z.number().positive(),
    matchPostingTextWhenTitleUnmatched: z.boolean(),
    unmatched: BucketSchema,
    notes: z.string().optional(),
    classes: z.array(RoleClassSchema).min(1),
  }),
  companyTier: z.object({
    maxPoints: z.number().positive(),
    faangPlusTier: z.number().int().min(1),
    defaultTier: z.number().int().min(1),
    unknownTierFraction: FractionSchema,
    tiers: z
      .array(
        z.object({
          tier: z.number().int().min(1),
          fraction: FractionSchema,
          label: z.string().min(1),
        }),
      )
      .min(1),
  }),
  location: z.object({
    maxPoints: z.number().positive(),
    usCountryCodes: z.array(z.string().min(1)).min(1),
    remote: BucketSchema,
    homeMetro: PatternBucketSchema,
    hubs: PatternBucketSchema,
    restOfUs: BucketSchema,
    nonUs: BucketSchema,
    unknown: BucketSchema,
  }),
  freshness: z.object({
    maxPoints: z.number().positive(),
    halfLifeDays: z.number().positive(),
    missingPostedAtFraction: FractionSchema,
    missingPostedAtLabel: z.string().min(1),
  }),
  deadlineUrgency: z.object({
    maxPoints: z.number().positive(),
    windowDays: z.number().positive(),
    inWindowFraction: FractionSchema,
    outsideWindowFraction: FractionSchema,
    pastFraction: FractionSchema,
    missingFraction: FractionSchema,
  }),
  disqualifiers: z.object({
    advancedDegrees: z.object({
      reasonPrefix: z.string().optional(),
      bachelorsExempt: z.boolean(),
      bachelorsExemptNote: z.string().optional(),
      bachelorPatterns: PatternsSchema,
      degrees: z
        .array(
          z.object({
            id: z.string().min(1),
            reason: z.string().min(1),
            patterns: PatternsSchema,
          }),
        )
        .min(1),
      textPatterns: z.array(
        z.object({ pattern: PatternSchema, reason: z.string().min(1) }),
      ),
      textExemptPatterns: z.array(PatternSchema),
    }),
    workAuthorization: z.object({
      reason: z.string().min(1),
      remoteExempt: z.boolean(),
      blockedCountries: z.array(z.string().min(1)),
    }),
    closed: z.object({ reason: z.string().min(1) }),
  }),
  thresholds: z.object({
    detailFetchMin: z.number().min(0).max(100),
    llmMin: z.number().min(0).max(100),
  }),
  llm: z.object({
    enabled: z.boolean(),
    model: z.string().min(1),
    maxAdjustment: z.number().int().min(0),
    maxPostingTextChars: z.number().int().positive(),
    maxRationaleChars: z.number().int().positive(),
    maxTokens: z.number().int().positive(),
    /** Sampling temperature. Defaults to 0 — see lib/scoring/llm.ts. */
    temperature: z.number().min(0).max(1).default(0),
  }),
});

export type ScoringConfig = z.infer<typeof ScoringConfigSchema>;
export type ComponentName = keyof z.infer<typeof WeightsSchema>;

/** The six weighted components, in breakdown order. */
export const COMPONENT_NAMES = [
  "techFit",
  "roleType",
  "companyTier",
  "location",
  "freshness",
  "deadlineUrgency",
] as const satisfies readonly ComponentName[];

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const DEFAULT_RELATIVE_PATH = path.join("config", "scoring.json");

function resolveConfigPath(): string {
  const override = process.env.SCORING_CONFIG_PATH;
  if (override && override.trim() !== "") return path.resolve(override);
  // In containers the file is volume-mounted at <workdir>/config/scoring.json.
  return path.resolve(process.cwd(), DEFAULT_RELATIVE_PATH);
}

/**
 * `<repo>/config/scoring.json`, or `SCORING_CONFIG_PATH` when set. Resolved at
 * module load for callers that just want to show the path; `loadScoringConfig`
 * re-resolves on every call so a late env change still takes effect.
 */
export const SCORING_CONFIG_PATH: string = resolveConfigPath();

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, array order preserved (arrays are
 * meaningful here — role-class order encodes specificity). Two files that
 * differ only in key order or whitespace hash identically.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}

export function hashScoringConfig(config: unknown): string {
  return createHash("sha256").update(stableStringify(config), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export class ScoringConfigError extends Error {
  readonly path: string;
  constructor(configPath: string, detail: string, options?: { cause?: unknown }) {
    super(`Invalid scoring config at ${configPath}: ${detail}`, options);
    this.name = "ScoringConfigError";
    this.path = configPath;
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
    .join("; ");
}

/**
 * Read, validate and hash the scoring config. Called on every scoring run —
 * there is no module-level cache on purpose.
 *
 * @param readFile injectable reader (defaults to `fs.readFileSync(path, "utf8")`).
 * @throws {ScoringConfigError} when the file is missing, unparseable, or fails
 *         validation. The message always names the path and the Zod issue.
 */
export function loadScoringConfig(
  readFile: (filePath: string) => string = (filePath) => readFileSync(filePath, "utf8"),
): { config: ScoringConfig; hash: string } {
  const configPath = resolveConfigPath();

  let text: string;
  try {
    text = readFile(configPath);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ScoringConfigError(configPath, `could not read file (${detail})`, { cause });
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new ScoringConfigError(configPath, `not valid JSON (${detail})`, { cause });
  }

  const result = ScoringConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ScoringConfigError(configPath, formatIssues(result.error), { cause: result.error });
  }

  // Hash the validated config so cosmetic edits (key order, whitespace,
  // comment-ish "notes" reordering is still content, so it still counts) do not
  // trigger a pointless rescore.
  return { config: result.data, hash: hashScoringConfig(result.data) };
}
