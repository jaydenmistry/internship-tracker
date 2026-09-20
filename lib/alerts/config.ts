import { prisma } from "@/lib/db";
import {
  ALERT_SETTINGS_KEY,
  AlertSettingsSchema,
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  type AlertSettings,
} from "./settings";

/**
 * The alert thresholds and per-channel toggles, stored as one JSON row in
 * `Setting` (key `alerts.thresholds`) so the UI can edit them without a deploy.
 *
 * Reads never throw: a missing row, a malformed row, or an unreachable field
 * falls back to the documented default and logs what it ignored. Alerting that
 * refuses to run because a number is out of range is worse than alerting on a
 * default.
 *
 * Scoring weights are NOT here — they live in `config/scoring.json`.
 */

export {
  ALERT_SETTINGS_KEY,
  AlertSettingsSchema,
  DEFAULT_ALERT_SETTINGS,
  parseAlertSettings,
  type AlertSettings,
};

export async function loadAlertSettings(): Promise<AlertSettings> {
  let row: { value: unknown } | null = null;
  try {
    row = await prisma.setting.findUnique({ where: { key: ALERT_SETTINGS_KEY } });
  } catch (err) {
    console.warn(`[alerts] could not read ${ALERT_SETTINGS_KEY}, using defaults:`, err);
    return DEFAULT_ALERT_SETTINGS;
  }

  const { settings, issues } = parseAlertSettings(row?.value ?? undefined);
  if (issues.length > 0) {
    console.warn(`[alerts] ignoring invalid ${ALERT_SETTINGS_KEY} fields: ${issues.join("; ")}`);
  }
  return settings;
}

/**
 * Writes the full settings object. Callers validate their own input first (see
 * app/alerts/actions.ts); this re-validates anyway, because a Server Action is
 * a public endpoint and the row it writes is read back by the worker.
 */
export async function saveAlertSettings(input: unknown): Promise<AlertSettings> {
  const parsed = AlertSettingsSchema.parse(input);
  await prisma.setting.upsert({
    where: { key: ALERT_SETTINGS_KEY },
    create: { key: ALERT_SETTINGS_KEY, value: parsed },
    update: { value: parsed },
  });
  return parsed;
}
