import type { AlertChannel, AlertKind } from "@/lib/alerts/types";
import type { AlertSettings } from "@/lib/alerts/settings";

/**
 * Pure presentation data for /alerts. No React, no DOM, no I/O — and no import
 * that reaches the Prisma client, so the client bundle stays clean. The bounds
 * below mirror `AlertSettingsSchema`; the server re-validates regardless, these
 * only drive the native input affordances.
 */

export const KIND_LABELS: Record<AlertKind, string> = {
  DAILY_DIGEST: "Daily digest",
  HIGH_SCORE: "High score",
  CLOSING_SOON: "Closing soon",
};

export const KIND_BLURBS: Record<AlertKind, string> = {
  DAILY_DIGEST: "New listings from the last lookback window that clear the digest score.",
  HIGH_SCORE: "Fires as soon as a listing lands at or above the high-score threshold.",
  CLOSING_SOON: "Saved or high-scoring roles with a deadline in the window and no application.",
};

export const CHANNEL_LABELS: Record<AlertChannel, string> = {
  DISCORD: "Discord",
  EMAIL: "Email",
};

export const KINDS: AlertKind[] = ["DAILY_DIGEST", "HIGH_SCORE", "CLOSING_SOON"];

type NumericKey = {
  [K in keyof AlertSettings]: AlertSettings[K] extends number ? K : never;
}[keyof AlertSettings];

export interface NumberField {
  key: NumericKey;
  label: string;
  hint: string;
  min: number;
  max: number;
  unit?: string;
}

export const NUMBER_FIELDS: NumberField[] = [
  {
    key: "digestMinScore",
    label: "Digest score minimum",
    hint: "A new listing needs at least this score to appear in the daily digest.",
    min: 0,
    max: 100,
  },
  {
    key: "digestLookbackHours",
    label: "Digest lookback",
    hint: "How far back “new” reaches when the digest is built.",
    min: 1,
    max: 168,
    unit: "hours",
  },
  {
    key: "highScoreMin",
    label: "High-score minimum",
    hint: "At or above this score a listing is alerted immediately, after every cycle.",
    min: 0,
    max: 100,
  },
  {
    key: "closingSoonDays",
    label: "Closing-soon window",
    hint: "A deadline this many calendar days out (or fewer) counts as closing soon.",
    min: 1,
    max: 90,
    unit: "days",
  },
  {
    key: "maxItemsPerDigest",
    label: "Max items per digest",
    hint: "Listings named in one digest; anything beyond is counted, not listed.",
    min: 1,
    max: 200,
  },
  {
    key: "maxAlertsPerRun",
    label: "Max alerts per run",
    hint: "Cap on per-listing alerts in one run, applied after dedupe so a backlog drains over later runs.",
    min: 1,
    max: 200,
  },
];

export interface ToggleField {
  key: "discordEnabled" | "emailEnabled";
  channel: AlertChannel;
}

export const TOGGLE_FIELDS: ToggleField[] = [
  { key: "discordEnabled", channel: "DISCORD" },
  { key: "emailEnabled", channel: "EMAIL" },
];

/** Settings as form strings, so a half-typed number never becomes NaN. */
export type SettingsForm = Record<NumericKey, string> & {
  discordEnabled: boolean;
  emailEnabled: boolean;
};

export function toForm(settings: AlertSettings): SettingsForm {
  const form = { discordEnabled: settings.discordEnabled, emailEnabled: settings.emailEnabled } as SettingsForm;
  for (const field of NUMBER_FIELDS) form[field.key] = String(settings[field.key]);
  return form;
}

/**
 * Form back to a payload for the Server Action. Returns the first problem
 * rather than a partial object: the action validates again, but catching an
 * empty box here keeps the error next to the field that caused it.
 */
export function fromForm(form: SettingsForm): { ok: true; value: AlertSettings } | { ok: false; message: string } {
  const out: Record<string, number | boolean> = {
    discordEnabled: form.discordEnabled,
    emailEnabled: form.emailEnabled,
  };
  for (const field of NUMBER_FIELDS) {
    const raw = form[field.key].trim();
    const value = Number(raw);
    if (raw === "" || !Number.isInteger(value)) {
      return { ok: false, message: `${field.label} must be a whole number.` };
    }
    if (value < field.min || value > field.max) {
      return { ok: false, message: `${field.label} must be between ${field.min} and ${field.max}.` };
    }
    out[field.key] = value;
  }
  return { ok: true, value: out as unknown as AlertSettings };
}
