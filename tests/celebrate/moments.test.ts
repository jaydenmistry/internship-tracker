import { describe, expect, it } from "vitest";
import type { AppStatus } from "@/generated/prisma/enums";
import {
  celebrationMessage,
  milestoneFor,
  momentFor,
  streakLength,
  type ApplyProgress,
} from "@/lib/celebrate/moments";

const progress = (p: Partial<ApplyProgress> = {}): ApplyProgress => ({
  total: 7,
  today: 2,
  streak: 1,
  milestone: null,
  ...p,
});

describe("momentFor", () => {
  it("celebrates applying from not-applied or skipped", () => {
    expect(momentFor(null, "APPLIED")).toBe("applied");
    expect(momentFor("NOT_APPLIED", "APPLIED")).toBe("applied");
    expect(momentFor("SKIPPED", "APPLIED")).toBe("applied");
  });

  it("stays quiet for corrections and backward moves into applied", () => {
    expect(momentFor("CLOSED", "APPLIED")).toBeNull();
    expect(momentFor("INTERVIEW", "APPLIED")).toBeNull();
    expect(momentFor("APPLIED", "APPLIED")).toBeNull();
  });

  it("celebrates every step forward, including skipping ahead", () => {
    expect(momentFor("APPLIED", "OA")).toBe("oa");
    expect(momentFor("OA", "PHONE_SCREEN")).toBe("phone");
    expect(momentFor("APPLIED", "INTERVIEW")).toBe("interview");
    expect(momentFor("INTERVIEW", "OFFER")).toBe("offer");
    expect(momentFor(null, "OFFER")).toBe("offer");
  });

  it("never celebrates a step backwards", () => {
    expect(momentFor("OFFER", "INTERVIEW")).toBeNull();
    expect(momentFor("INTERVIEW", "OA")).toBeNull();
  });

  it("gives a rejection its gentle moment only for something that was sent", () => {
    for (const from of ["APPLIED", "OA", "PHONE_SCREEN", "INTERVIEW"] as AppStatus[]) {
      expect(momentFor(from, "REJECTED")).toBe("rejected");
    }
    expect(momentFor(null, "REJECTED")).toBeNull();
    expect(momentFor("SKIPPED", "REJECTED")).toBeNull();
    expect(momentFor("OFFER", "REJECTED")).toBeNull();
  });

  it("ignores closing, skipping and un-applying", () => {
    expect(momentFor("APPLIED", "CLOSED")).toBeNull();
    expect(momentFor(null, "SKIPPED")).toBeNull();
    expect(momentFor("APPLIED", "NOT_APPLIED")).toBeNull();
  });
});

describe("milestones and streaks", () => {
  it("lands on the milestone numbers only", () => {
    expect(milestoneFor(1)).toBe(1);
    expect(milestoneFor(50)).toBe(50);
    expect(milestoneFor(100)).toBe(100);
    expect(milestoneFor(2)).toBeNull();
    expect(milestoneFor(99)).toBeNull();
  });

  it("counts consecutive days back from today", () => {
    const days = new Set(["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-18"]);
    expect(streakLength(days, "2026-10-22")).toBe(3);
    expect(streakLength(days, "2026-10-23")).toBe(0);
    expect(streakLength(new Set(), "2026-10-22")).toBe(0);
  });

  it("crosses month and year boundaries", () => {
    expect(streakLength(new Set(["2026-12-31", "2027-01-01"]), "2027-01-01")).toBe(2);
    expect(streakLength(new Set(["2026-02-28", "2026-03-01"]), "2026-03-01")).toBe(2);
  });
});

describe("celebrationMessage", () => {
  const first = () => 0;

  it("names the company", () => {
    expect(celebrationMessage("oa", { company: "Stripe", random: first })).toContain("Stripe");
    expect(celebrationMessage("applied", { company: "Stripe", random: first })).toBe("Applied to Stripe! 🚀");
  });

  it("calls out the first application of the day, a dream role, and a streak", () => {
    expect(celebrationMessage("applied", { company: "Ramp", progress: progress({ today: 1 }) })).toMatch(
      /^First application of the day: Ramp/,
    );
    expect(celebrationMessage("applied", { company: "Ramp", dream: true, progress: progress() })).toMatch(
      /^Dream role alert/,
    );
    expect(
      celebrationMessage("applied", { company: "Ramp", progress: progress({ streak: 4 }), random: first }),
    ).toMatch(/🔥 4-day streak$/);
    expect(
      celebrationMessage("applied", { company: "Ramp", progress: progress({ streak: 1 }), random: first }),
    ).not.toMatch(/streak/);
  });

  it("puts a milestone first", () => {
    expect(celebrationMessage("applied", { company: "Ramp", progress: progress({ total: 50, milestone: 50 }) })).toMatch(
      /^🎉 50 applications sent!/,
    );
    expect(celebrationMessage("applied", { company: "Ramp", progress: progress({ total: 1, milestone: 1 }) })).toMatch(
      /first application/,
    );
  });

  it("only reads progress for applications", () => {
    expect(
      celebrationMessage("interview", { company: "Ramp", progress: progress({ milestone: 50, streak: 5 }), random: first }),
    ).not.toMatch(/applications sent|streak/);
  });
});
