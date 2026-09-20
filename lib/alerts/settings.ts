import { z } from "zod";

/**
 * The alert knobs, as a pure schema.
 *
 * Split from `config.ts` (which reads and writes the `Setting` table) so the
 * pure builder and its tests can import the defaults without pulling in the
 * Prisma client.
 *
 * Scoring weights do NOT live here — they stay in `config/scoring.json`, which
 * is hashed on every scoring run. These are only the alerting thresholds.
 */

/** `Setting.key` holding the JSON below. */
export const ALERT_SETTINGS_KEY = "alerts.thresholds";

export const AlertSettingsSchema = z.object({
  /** Minimum finalScore for a listing to appear in the daily digest. */
  digestMinScore: z.number().int().min(0).max(100).default(70),
  /** How far back "new" reaches for the digest, in hours. */
  digestLookbackHours: z.number().int().min(1).max(168).default(24),
  /** At or above this finalScore, a listing gets an immediate alert. */
  highScoreMin: z.number().int().min(0).max(100).default(85),
  /** A deadline this many calendar days out (or fewer) is "closing soon". */
  closingSoonDays: z.number().int().min(1).max(90).default(7),
  /** Hard cap on listings named in one digest; the rest are counted, not listed. */
  maxItemsPerDigest: z.number().int().min(1).max(200).default(25),
  /**
   * Hard cap on per-listing alerts sent in one run, applied AFTER dedupe so a
   * backlog drains over successive runs instead of the same top N being picked
   * and skipped forever. Stops the first run after a big ingest from firing
   * hundreds of messages at once.
   */
  maxAlertsPerRun: z.number().int().min(1).max(200).default(20),
  discordEnabled: z.boolean().default(true),
  emailEnabled: z.boolean().default(true),
});

export type AlertSettings = z.infer<typeof AlertSettingsSchema>;

export const ALERT_SETTING_KEYS = Object.keys(
  AlertSettingsSchema.shape,
) as (keyof AlertSettings)[];

export const DEFAULT_ALERT_SETTINGS: AlertSettings = AlertSettingsSchema.parse({});

/**
 * Field-by-field parse: a malformed or missing value falls back to its default
 * instead of discarding the whole row. A settings row that lost one key (or
 * gained one in a later version) must not silently reset every other knob —
 * and an alerting system that refuses to run because one number is out of
 * range is worse than one that runs on a documented default.
 *
 * `issues` is returned rather than thrown so the caller can log it.
 */
export function parseAlertSettings(raw: unknown): {
  settings: AlertSettings;
  issues: string[];
} {
  if (raw === undefined || raw === null) return { settings: DEFAULT_ALERT_SETTINGS, issues: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: DEFAULT_ALERT_SETTINGS, issues: ["value is not a JSON object"] };
  }

  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_ALERT_SETTINGS };
  const issues: string[] = [];

  for (const key of ALERT_SETTING_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    const parsed = AlertSettingsSchema.shape[key].safeParse(value);
    if (parsed.success) out[key] = parsed.data;
    else issues.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }

  for (const key of Object.keys(source)) {
    if (!(ALERT_SETTING_KEYS as string[]).includes(key)) issues.push(`${key}: unknown setting (ignored)`);
  }

  return { settings: out as AlertSettings, issues };
}
