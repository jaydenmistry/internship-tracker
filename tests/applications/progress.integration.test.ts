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
});
