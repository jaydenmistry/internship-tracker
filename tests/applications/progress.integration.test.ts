import { beforeEach, describe, expect, it } from "vitest";
import type { AppStatus } from "@/generated/prisma/enums";
import { hasTestDatabase } from "../db-url";

const hasDb = hasTestDatabase();
const TZ = "America/New_York";
// 2026-10-22, mid-afternoon in New York.
const NOW = new Date("2026-10-22T19:00:00Z");

describe.skipIf(!hasDb)("apply progress (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let loadApplyProgress: (typeof import("@/lib/applications/progress"))["loadApplyProgress"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ loadApplyProgress } = await import("@/lib/applications/progress"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.setting.deleteMany({ where: { key: { in: ["apply.weeklyGoal", "achievements.announced"] } } });
  });

  async function app(status: AppStatus, appliedAt: string[] = []) {
    await prisma.application.create({
      data: {
        companyName: "Acme",
        roleTitle: "SWE Intern",
        status,
        events: { create: appliedAt.map((at) => ({ toStatus: "APPLIED" as const, occurredAt: new Date(at) })) },
      },
    });
  }

  it("counts sent applications, today's, and the streak in the configured zone", async () => {
    await app("APPLIED", ["2026-10-22T14:00:00Z"]);
    await app("INTERVIEW", ["2026-10-21T15:00:00Z"]);
    // 01:00 UTC on the 21st is still the 20th in New York.
    await app("REJECTED", ["2026-10-21T01:00:00Z"]);
    await app("SKIPPED");
    await app("NOT_APPLIED");

    const p = await loadApplyProgress({ now: NOW, timeZone: TZ });
    expect(p.total).toBe(3);
    expect(p.today).toBe(1);
    expect(p.streak).toBe(3);
    expect(p.milestone).toBeNull();
  });

  it("counts an application once a day even if it was re-applied", async () => {
    await app("APPLIED", ["2026-10-22T13:00:00Z", "2026-10-22T13:05:00Z"]);
    const p = await loadApplyProgress({ now: NOW, timeZone: TZ });
    expect(p.today).toBe(1);
    expect(p.total).toBe(1);
    expect(p.milestone).toBe(1);
  });

  it("has no streak when nothing was applied today", async () => {
    await app("APPLIED", ["2026-10-21T15:00:00Z"]);
    const p = await loadApplyProgress({ now: NOW, timeZone: TZ });
    expect(p.today).toBe(0);
    expect(p.streak).toBe(0);
  });

  it("counts this week from Monday, only applications still sent, against the goal", async () => {
    const progress = await import("@/lib/applications/progress");
    const at = async (status: AppStatus, appliedAt: string) =>
      prisma.application.create({
        data: { companyName: "Acme", roleTitle: "SWE", status, appliedAt: new Date(appliedAt) },
      });
    // NOW is Thursday 2026-10-22; the week started Monday the 19th.
    await at("APPLIED", "2026-10-19T14:00:00Z");
    await at("REJECTED", "2026-10-21T14:00:00Z");
    await at("APPLIED", "2026-10-18T14:00:00Z"); // Sunday: last week
    await at("NOT_APPLIED", "2026-10-20T14:00:00Z"); // un-applied: not counted

    expect(await progress.loadWeekProgress({ now: NOW, timeZone: TZ })).toEqual({ week: 2, goal: 10 });
    await progress.saveWeeklyGoal(2);
    const p = await loadApplyProgress({ now: NOW, timeZone: TZ });
    expect(p).toMatchObject({ week: 2, goal: 2, goalReached: true });
    await progress.saveWeeklyGoal(null);
    expect(await progress.loadWeeklyGoal()).toBeNull();
  });

  it("announces a badge once, and seeds history silently on the first run", async () => {
    const { announceNewAchievements } = await import("@/lib/applications/progress");
    await prisma.application.create({
      data: { companyName: "Old", roleTitle: "SWE", status: "APPLIED", appliedAt: new Date("2026-01-05T15:00:00Z") },
    });
    // First run: the January application's "first step" is history, not news.
    expect(await announceNewAchievements({ now: NOW, timeZone: TZ })).toEqual([]);

    // Ten more just now (02:00–02:09 in New York): double digits, night owl,
    // ten in a day, and the default goal of 10 a week.
    for (let i = 0; i < 10; i++) {
      await prisma.application.create({
        data: { companyName: `N${i}`, roleTitle: "SWE", status: "APPLIED", appliedAt: new Date(`2026-10-22T06:0${i}:00Z`) },
      });
    }
    const fresh = await announceNewAchievements({ now: NOW, timeZone: TZ });
    expect(fresh.map((a) => a.id).sort()).toEqual(["goal-getter", "night-owl", "sprinter", "ten"]);
    expect(await announceNewAchievements({ now: NOW, timeZone: TZ })).toEqual([]);

    // Raising the goal re-locks "goal getter"; it must stay announced.
    const { saveWeeklyGoal } = await import("@/lib/applications/progress");
    await saveWeeklyGoal(20);
    for (let i = 0; i < 5; i++) {
      await prisma.application.create({
        data: { companyName: `E${i}`, roleTitle: "SWE", status: "APPLIED", appliedAt: new Date(`2026-10-22T11:0${i}:00Z`) },
      });
    }
    // 07:00 in New York: early bird is new; the union keeps goal-getter recorded.
    expect((await announceNewAchievements({ now: NOW, timeZone: TZ })).map((a) => a.id)).toEqual(["early-bird"]);
    const row = await prisma.setting.findUnique({ where: { key: "achievements.announced" } });
    expect((row?.value as { ids: string[] }).ids).toContain("goal-getter");
  });

  it("fires the goal only for the application that was just sent", async () => {
    const progress = await import("@/lib/applications/progress");
    await progress.saveWeeklyGoal(2);
    const old = await prisma.application.create({
      data: { companyName: "A", roleTitle: "SWE", status: "APPLIED", appliedAt: new Date("2026-10-20T14:00:00Z") },
    });
    const fresh = await prisma.application.create({
      data: { companyName: "B", roleTitle: "SWE", status: "APPLIED", appliedAt: new Date(NOW.getTime() - 30_000) },
    });
    const opts = { now: NOW, timeZone: TZ };
    expect((await loadApplyProgress({ ...opts, justSent: { applicationId: fresh.id } })).goalReached).toBe(true);
    // Re-applying one sent on Tuesday keeps its appliedAt: no second party.
    expect((await loadApplyProgress({ ...opts, justSent: { applicationId: old.id } })).goalReached).toBe(false);
  });

  it("builds the heatmap from when applications were sent", async () => {
    const { loadHeatmap } = await import("@/lib/applications/progress");
    await app("APPLIED", ["2026-10-22T14:00:00Z"]);
    await prisma.application.create({
      data: { companyName: "B", roleTitle: "SWE", status: "OA", appliedAt: new Date("2026-10-21T14:00:00Z") },
    });
    const map = await loadHeatmap({ now: NOW, timeZone: TZ });
    expect(map.total).toBe(2);
    expect(map.currentStreak).toBe(2);
  });
});
