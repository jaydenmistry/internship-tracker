import { describe, expect, it } from "vitest";
import {
  ACHIEVEMENTS,
  appliedDays,
  evaluateAchievements,
  sentDay,
  newlyUnlocked,
  type AchievementFacts,
  type AppliedFact,
  type EventFact,
} from "@/lib/celebrate/achievements";

const TZ = "America/New_York";

let seq = 0;
function sent(at: string, extra: Partial<AppliedFact> = {}): AppliedFact {
  seq += 1;
  return { applicationId: `a${seq}`, at: new Date(at), faangPlus: false, deadline: null, ...extra };
}

function facts(p: Partial<AchievementFacts>): AchievementFacts {
  return { applied: [], events: [], weeklyGoal: 10, timeZone: TZ, ...p };
}

function badge(f: AchievementFacts, id: string) {
  const a = evaluateAchievements(f).find((x) => x.id === id);
  if (!a) throw new Error(`no badge ${id}`);
  return a;
}

describe("achievements", () => {
  it("has unique ids", () => {
    expect(new Set(ACHIEVEMENTS.map((a) => a.id)).size).toBe(ACHIEVEMENTS.length);
  });

  it("dates count badges at the application that earned them, and shows progress before", () => {
    const applied = Array.from({ length: 10 }, (_, i) => sent(`2026-10-${String(i + 1).padStart(2, "0")}T15:00:00Z`));
    expect(badge(facts({ applied }), "first-step").unlockedAt).toEqual(new Date("2026-10-01T15:00:00Z"));
    expect(badge(facts({ applied }), "ten").unlockedAt).toEqual(new Date("2026-10-10T15:00:00Z"));
    const quarter = badge(facts({ applied }), "twenty-five");
    expect(quarter.unlockedAt).toBeNull();
    expect(quarter.progress).toEqual({ have: 10, need: 25 });
  });

  it("night owl and early bird read the hour in the configured zone", () => {
    // 06:30 UTC is 02:30 in New York (EDT).
    expect(badge(facts({ applied: [sent("2026-10-14T06:30:00Z")] }), "night-owl").unlockedAt).not.toBeNull();
    // 11:00 UTC is 07:00 in New York.
    const early = facts({ applied: [sent("2026-10-14T11:00:00Z")] });
    expect(badge(early, "early-bird").unlockedAt).not.toBeNull();
    expect(badge(early, "night-owl").unlockedAt).toBeNull();
  });

  it("sprinter needs 10 in one local day", () => {
    const nine = Array.from({ length: 9 }, () => sent("2026-10-14T15:00:00Z"));
    expect(badge(facts({ applied: nine }), "sprinter").progress).toEqual({ have: 9, need: 10 });
    expect(badge(facts({ applied: [...nine, sent("2026-10-14T20:00:00Z")] }), "sprinter").unlockedAt).not.toBeNull();
  });

  it("on fire needs 7 consecutive local days", () => {
    const six = Array.from({ length: 6 }, (_, i) => sent(`2026-10-0${i + 1}T15:00:00Z`));
    expect(badge(facts({ applied: six }), "on-fire").progress).toEqual({ have: 6, need: 7 });
    const seven = [...six, sent("2026-10-07T15:00:00Z")];
    expect(badge(facts({ applied: seven }), "on-fire").unlockedAt).toEqual(new Date("2026-10-07T15:00:00Z"));
    // A gap breaks it.
    const gap = [...six, sent("2026-10-08T15:00:00Z")];
    expect(badge(facts({ applied: gap }), "on-fire").unlockedAt).toBeNull();
  });

  it("big tech sweep wants 5 FAANG+ inside a 7-day window", () => {
    const big = (at: string) => sent(at, { faangPlus: true });
    const spread = ["01", "03", "05", "09", "11"].map((d) => big(`2026-10-${d}T15:00:00Z`));
    expect(badge(facts({ applied: spread }), "big-tech").unlockedAt).toBeNull();
    const tight = ["01", "02", "03", "05", "06"].map((d) => big(`2026-10-${d}T15:00:00Z`));
    expect(badge(facts({ applied: tight }), "big-tech").unlockedAt).toEqual(new Date("2026-10-06T15:00:00Z"));
  });

  it("closer: within 48 hours before the deadline, not after it", () => {
    const close = sent("2026-10-14T15:00:00Z", { deadline: new Date("2026-10-15T23:00:00Z") });
    expect(badge(facts({ applied: [close] }), "closer").unlockedAt).not.toBeNull();
    const late = sent("2026-10-16T15:00:00Z", { deadline: new Date("2026-10-15T23:00:00Z") });
    const early = sent("2026-10-01T15:00:00Z", { deadline: new Date("2026-10-15T23:00:00Z") });
    expect(badge(facts({ applied: [late, early] }), "closer").unlockedAt).toBeNull();
  });

  it("comeback is an interview after the third rejection", () => {
    const ev = (applicationId: string, status: EventFact["status"], at: string): EventFact => ({
      applicationId,
      status,
      at: new Date(at),
    });
    const rejections = [ev("r1", "REJECTED", "2026-10-01T12:00:00Z"), ev("r2", "REJECTED", "2026-10-02T12:00:00Z")];
    const interviewEarly = ev("i1", "INTERVIEW", "2026-10-02T18:00:00Z");
    const third = ev("r3", "REJECTED", "2026-10-03T12:00:00Z");
    expect(badge(facts({ events: [...rejections, interviewEarly, third] }), "comeback").unlockedAt).toBeNull();
    const later = ev("i2", "INTERVIEW", "2026-10-04T12:00:00Z");
    expect(badge(facts({ events: [...rejections, interviewEarly, third, later] }), "comeback").unlockedAt).toEqual(
      later.at,
    );
    // Two rejection events for one application are one rejection.
    const dupes = [ev("r1", "REJECTED", "2026-10-01T12:00:00Z"), ev("r1", "REJECTED", "2026-10-02T12:00:00Z")];
    expect(badge(facts({ events: dupes }), "comeback").progress).toEqual({ have: 1, need: 3 });
  });

  it("goal getter uses the current goal, and is off with no goal", () => {
    const week = Array.from({ length: 3 }, () => sent("2026-10-14T15:00:00Z"));
    expect(badge(facts({ applied: week, weeklyGoal: 3 }), "goal-getter").unlockedAt).not.toBeNull();
    expect(badge(facts({ applied: week, weeklyGoal: 4 }), "goal-getter").progress).toEqual({ have: 3, need: 4 });
    expect(badge(facts({ applied: week, weeklyGoal: null }), "goal-getter").unlockedAt).toBeNull();
  });
});

describe("date-only imports", () => {
  it("count on the date as written and never earn an hour badge", () => {
    // Midnight UTC is 8pm the day before in New York; a CSV date means the date.
    const imported = sent("2026-10-19T00:00:00Z", { dateOnly: true });
    expect(sentDay(imported, TZ)).toBe("2026-10-19");
    expect(badge(facts({ applied: [imported] }), "night-owl").unlockedAt).toBeNull();
    expect(appliedDays([imported], TZ).get("2026-10-19")).toBe(1);
  });
});

describe("newlyUnlocked", () => {
  const now = new Date("2026-10-14T16:00:00Z");
  const all = evaluateAchievements(
    facts({ applied: [sent("2026-09-01T15:00:00Z"), ...Array.from({ length: 9 }, () => sent("2026-10-14T15:58:00Z"))] }),
  );

  it("announces what isn't recorded yet", () => {
    expect(newlyUnlocked(all, new Set(["first-step"]), now).map((a) => a.id)).toEqual(["ten"]);
    expect(newlyUnlocked(all, new Set(["first-step", "ten"]), now)).toEqual([]);
  });

  it("on the first run, only badges earned in the last few minutes", () => {
    expect(newlyUnlocked(all, null, now).map((a) => a.id)).toEqual(["ten"]);
  });
});
