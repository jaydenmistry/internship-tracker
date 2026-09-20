import type { AlertListing } from "@/lib/alerts/types";
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from "@/lib/alerts/settings";

/**
 * Fixtures for the pure alert tests. Everything is explicit — no clock, no
 * database — so a failure points at the builder, not at the day it ran.
 */

/** Fixed "now" for every pure test. UTC, so the timezone is never implicit. */
export const NOW = new Date("2026-09-20T12:00:00Z");

/** The pure tests pass an explicit zone so calendar arithmetic is deterministic. */
export const TZ = "UTC";

export function listing(overrides: Partial<AlertListing> & { id: string }): AlertListing {
  return {
    company: "Acme",
    title: "Software Engineer Intern",
    location: "Atlanta, GA",
    url: `https://jobs.example.test/${overrides.id}`,
    score: 80,
    deadline: null,
    firstSeen: new Date("2026-09-20T06:00:00Z"),
    saved: false,
    dismissed: false,
    disqualified: false,
    likelyClosed: false,
    applied: false,
    ...overrides,
  };
}

export function settings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return { ...DEFAULT_ALERT_SETTINGS, ...overrides };
}

/** `days` calendar days after NOW, at midday so a rounding bug is visible. */
export function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}
