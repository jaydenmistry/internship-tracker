import { describe, expect, it } from "vitest";
import { dqBadge, rankMovement } from "@/app/listings/table-state";
import { rowFixture } from "./fixtures/listing-detail";

describe("rank movement indicator", () => {
  it("shows ↑N when the listing rose and ↓N when it fell", () => {
    expect(rankMovement(5)).toMatchObject({ text: "↑5", direction: "up" });
    expect(rankMovement(-12)).toMatchObject({ text: "↓12", direction: "down" });
  });

  it("shows nothing when there is no movement to report", () => {
    expect(rankMovement(0)).toBeNull();
    expect(rankMovement(null)).toBeNull();
    expect(rankMovement(undefined)).toBeNull();
    expect(rankMovement(Number.NaN)).toBeNull();
  });

  it("follows the rankDelta prepareRows derives (previousRank - rank)", () => {
    expect(rankMovement(rowFixture({ rank: 4, previousRank: 9 }).rankDelta)?.text).toBe("↑5");
    expect(rankMovement(rowFixture({ rank: 30, previousRank: 12 }).rankDelta)?.text).toBe("↓18");
    expect(rankMovement(rowFixture({ rank: null, previousRank: 12 }).rankDelta)).toBeNull();
    expect(rankMovement(rowFixture({ rank: 7, previousRank: null }).rankDelta)).toBeNull();
  });

  it("has a plain-language label for the tooltip", () => {
    expect(rankMovement(3)?.label).toMatch(/moved up 3/);
    expect(rankMovement(-3)?.label).toMatch(/moved down 3/);
  });
});

describe("disqualified badge", () => {
  const DEGREE = "requires PhD";
  const AUTH = "Canada/UK/EU work authorization";

  it("names a single reason in full", () => {
    expect(dqBadge([DEGREE])).toEqual({ text: `dq: ${DEGREE}`, title: `Disqualified — ${DEGREE}` });
  });

  it("counts multiple reasons and lists every one in the title", () => {
    const b = dqBadge([DEGREE, AUTH]);
    expect(b.text).toBe(`dq ×2: ${DEGREE} +1`);
    expect(b.title).toContain(DEGREE);
    expect(b.title).toContain(AUTH);
  });

  it("makes two grounds distinguishable from either alone", () => {
    const both = dqBadge([DEGREE, AUTH]).text;
    expect(new Set([both, dqBadge([DEGREE]).text, dqBadge([AUTH]).text]).size).toBe(3);
  });

  it("falls back to a bare marker with no recorded reason", () => {
    expect(dqBadge([]).text).toBe("dq");
    expect(dqBadge(["  "]).text).toBe("dq");
  });
});
