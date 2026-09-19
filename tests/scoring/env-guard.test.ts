import { afterEach, describe, expect, it } from "vitest";
import { positiveNumberFromEnv } from "@/lib/scoring/rescore";

/**
 * These knobs cap spending. A malformed value must fall back to the default,
 * never to NaN — `calls >= NaN` is always false, which would silently remove
 * the cap entirely and bill every candidate.
 */
describe("positiveNumberFromEnv", () => {
  const KEY = "TEST_SPEND_CAP";
  afterEach(() => {
    delete process.env[KEY];
  });

  const cases: Array<[string | undefined, number]> = [
    [undefined, 200],
    ["", 200],
    ["   ", 200],
    ["abc", 200], // the dangerous one: must not become NaN
    ["-5", 200], // negative cap is meaningless
    ["NaN", 200],
    ["Infinity", 200],
    ["0", 0], // explicit zero is a valid "disable"
    ["50", 50],
    ["  7  ", 7],
  ];

  it.each(cases)("%s → %i", (raw, expected) => {
    if (raw === undefined) delete process.env[KEY];
    else process.env[KEY] = raw;
    const result = positiveNumberFromEnv(KEY, 200);
    expect(result).toBe(expected);
    expect(Number.isNaN(result)).toBe(false);
  });
});
