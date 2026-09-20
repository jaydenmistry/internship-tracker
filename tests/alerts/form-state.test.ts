import { describe, expect, it } from "vitest";
import { fromForm, NUMBER_FIELDS, toForm } from "@/app/alerts/state";
import { AlertSettingsSchema, DEFAULT_ALERT_SETTINGS } from "@/lib/alerts/settings";

/**
 * The /alerts form keeps numbers as strings while they are being typed, so a
 * half-deleted box is an empty string rather than NaN. These cover the
 * conversion in both directions; the Server Action re-validates regardless.
 */

describe("settings form", () => {
  it("round-trips the defaults unchanged", () => {
    const result = fromForm(toForm(DEFAULT_ALERT_SETTINGS));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(DEFAULT_ALERT_SETTINGS);
  });

  it("produces a payload the server schema accepts", () => {
    const result = fromForm(toForm({ ...DEFAULT_ALERT_SETTINGS, highScoreMin: 91 }));
    if (!result.ok) throw new Error(result.message);
    expect(AlertSettingsSchema.parse(result.value).highScoreMin).toBe(91);
  });

  it("rejects an empty or fractional box, naming the field", () => {
    const empty = fromForm({ ...toForm(DEFAULT_ALERT_SETTINGS), highScoreMin: "" });
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.message).toContain("High-score minimum");

    const fractional = fromForm({ ...toForm(DEFAULT_ALERT_SETTINGS), closingSoonDays: "3.5" });
    expect(fractional.ok).toBe(false);
  });

  it("rejects a value outside the field's range", () => {
    const tooHigh = fromForm({ ...toForm(DEFAULT_ALERT_SETTINGS), digestMinScore: "101" });
    expect(tooHigh.ok).toBe(false);
    if (!tooHigh.ok) expect(tooHigh.message).toContain("between 0 and 100");
  });

  it("keeps the toggles as booleans", () => {
    const result = fromForm({ ...toForm(DEFAULT_ALERT_SETTINGS), discordEnabled: false });
    if (!result.ok) throw new Error(result.message);
    expect(result.value.discordEnabled).toBe(false);
    expect(result.value.emailEnabled).toBe(true);
  });

  it("covers every numeric setting, so a new knob cannot be left out of the form", () => {
    const numericKeys = Object.entries(DEFAULT_ALERT_SETTINGS)
      .filter(([, v]) => typeof v === "number")
      .map(([k]) => k)
      .sort();
    expect(NUMBER_FIELDS.map((f) => f.key).sort()).toEqual(numericKeys);
  });
});
