import { describe, expect, it } from "vitest";
import { loadScoringConfig } from "@/lib/scoring/config";
import { scoreListing, type ScoringInput } from "@/lib/scoring/engine";

/**
 * gateScore decides which postings are worth fetching. It must NOT count
 * missing posting text as a zero, or the pipeline deadlocks: no text → techFit
 * 0 → score below the gate → no fetch → no text.
 */
const { config } = loadScoringConfig();
const NOW = new Date("2026-09-19T12:00:00Z");

/**
 * Title carries no tracked skill token on purpose ("Backend" IS one), so this
 * models the common case: a listing whose techFit is genuinely unknown.
 */
function input(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    title: "Software Engineer Intern",
    category: "Software",
    postingText: null,
    locations: ["Atlanta, GA"],
    countries: ["US"],
    remote: false,
    degrees: [],
    sponsorship: null,
    postedAt: new Date("2026-09-09T00:00:00Z"),
    deadline: null,
    likelyClosed: false,
    terms: ["Summer 2027"],
    company: { name: "Stripe", faangPlus: true, tierOverride: null },
    ...overrides,
  };
}

describe("gateScore", () => {
  it("exceeds ruleScore when posting text is missing", () => {
    const r = scoreListing(input(), config, NOW);
    expect(r.breakdown.techFit.points).toBe(0);
    // ruleScore is dragged down by a techFit it had no data for; gateScore
    // simply leaves that component out.
    expect(r.gateScore).toBeGreaterThan(r.ruleScore);
  });

  it("lets a strong no-text listing clear the fetch gate its ruleScore could not", () => {
    // A FAANG+ role in the user's home city, recently posted — exactly the kind
    // of listing worth reading. Judged on ruleScore it never gets fetched.
    const r = scoreListing(input(), config, NOW);
    const gate = config.thresholds.detailFetchMin;
    expect(r.ruleScore).toBeLessThan(gate);
    expect(r.gateScore).toBeGreaterThanOrEqual(gate);
  });

  it("ignores techFit entirely — text that changes techFit leaves gateScore alone", () => {
    const withoutText = scoreListing(input(), config, NOW);
    const withText = scoreListing(
      input({
        postingText:
          "Build distributed systems in Go and Python on Kubernetes, Docker and AWS across Linux fleets.",
      }),
      config,
      NOW,
    );

    expect(withText.breakdown.techFit.points).toBeGreaterThan(0);
    expect(withText.ruleScore).toBeGreaterThan(withoutText.ruleScore);
    // Same listing, same non-techFit components → identical gate score.
    expect(withText.gateScore).toBe(withoutText.gateScore);
  });

  it("is zero for a disqualified listing, so closed roles are never fetched", () => {
    const r = scoreListing(input({ likelyClosed: true }), config, NOW);
    expect(r.disqualified).toBe(true);
    expect(r.ruleScore).toBe(0);
    expect(r.gateScore).toBe(0);
  });

  it("still ranks weak listings below strong ones on the gate scale", () => {
    const strong = scoreListing(input(), config, NOW);
    const weak = scoreListing(
      input({
        title: "IT Support Intern",
        locations: ["Boise, ID"],
        company: { name: "Anon Corp", faangPlus: false, tierOverride: null },
        postedAt: new Date("2026-06-01T00:00:00Z"),
      }),
      config,
      NOW,
    );
    expect(weak.gateScore).toBeLessThan(strong.gateScore);
  });

  it("stays within 0–100", () => {
    for (const l of [input(), input({ likelyClosed: true }), input({ postedAt: null })]) {
      const r = scoreListing(l, config, NOW);
      expect(r.gateScore).toBeGreaterThanOrEqual(0);
      expect(r.gateScore).toBeLessThanOrEqual(100);
    }
  });
});
