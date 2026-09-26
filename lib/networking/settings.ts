import { z } from "zod";

/**
 * Networking knobs, as a pure schema — stored as one JSON row in `Setting`
 * (key below) and edited on /network/settings. Split from the Prisma-backed
 * reader so the UI and tests can import the defaults.
 */

export const NETWORKING_SETTINGS_KEY = "networking";

export const VOICE_NOTES_MAX = 1000;

export const NetworkingSettingsSchema = z.object({
  /** Business days from an opener to the first follow-up. */
  firstFollowUpBusinessDays: z.number().int().min(1).max(30).default(5),
  /** Business days from each follow-up to the next (and to COLD after the last). */
  secondFollowUpBusinessDays: z.number().int().min(1).max(30).default(7),
  /** Follow-ups before a silent contact goes COLD. 0 = none. */
  maxFollowUps: z.number().int().min(0).max(5).default(2),
  /** Edited past messages of the same type included in a draft prompt (phase 3). */
  voiceExampleCount: z.number().int().min(0).max(10).default(3),
  /** How you write, in your words — included in every draft prompt (phase 3). */
  voiceNotes: z.string().max(VOICE_NOTES_MAX).default(""),
});

export type NetworkingSettings = z.infer<typeof NetworkingSettingsSchema>;

const KEYS = Object.keys(NetworkingSettingsSchema.shape) as (keyof NetworkingSettings)[];

export const DEFAULT_NETWORKING_SETTINGS: NetworkingSettings = NetworkingSettingsSchema.parse({});

/**
 * Field-by-field, like the alert settings: one bad or missing value falls back
 * to its default instead of resetting every other knob. Issues are returned,
 * not thrown, so the caller can log them.
 */
export function parseNetworkingSettings(raw: unknown): { settings: NetworkingSettings; issues: string[] } {
  if (raw === undefined || raw === null) return { settings: DEFAULT_NETWORKING_SETTINGS, issues: [] };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { settings: DEFAULT_NETWORKING_SETTINGS, issues: ["value is not a JSON object"] };
  }
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_NETWORKING_SETTINGS };
  const issues: string[] = [];
  for (const key of KEYS) {
    if (source[key] === undefined) continue;
    const parsed = NetworkingSettingsSchema.shape[key].safeParse(source[key]);
    if (parsed.success) out[key] = parsed.data;
    else issues.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  for (const key of Object.keys(source)) {
    if (!(KEYS as string[]).includes(key)) issues.push(`${key}: unknown setting (ignored)`);
  }
  return { settings: out as NetworkingSettings, issues };
}
