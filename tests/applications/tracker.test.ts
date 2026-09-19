import { describe, expect, it } from "vitest";
import { TRACKER_STATUSES, computeDashboard } from "@/lib/applications/tracker";
import type { AppStatus } from "@/generated/prisma/enums";

const a = (status: AppStatus, history: AppStatus[] = [], appliedAt: string | null = null) => ({
  status,
  history,
  appliedAt,
});

describe("computeDashboard", () => {
  it("reports every pipeline stage, zeros included", () => {
    const stats = computeDashboard([]);
    expect(Object.keys(stats.byStage)).toEqual([...TRACKER_STATUSES]);
    expect(Object.values(stats.byStage).every((n) => n === 0)).toBe(true);
    expect(stats.total).toBe(0);
  });

  it("has no response rate — not 0% — when nothing was submitted", () => {
    expect(computeDashboard([]).responseRate).toBeNull();
    expect(computeDashboard([a("SKIPPED")]).responseRate).toBeNull();
  });

  it("counts a rejection as a response", () => {
    const stats = computeDashboard([a("REJECTED", ["APPLIED", "REJECTED"])]);
    expect(stats.submitted).toBe(1);
    expect(stats.responded).toBe(1);
    expect(stats.responseRate).toBe(1);
  });

  it("uses history: OA → Rejected responded; Applied → Closed did not", () => {
    const stats = computeDashboard([
      a("REJECTED", ["APPLIED", "OA", "REJECTED"]),
      a("CLOSED", ["APPLIED", "CLOSED"], "2026-09-01T00:00:00Z"),
      a("APPLIED", ["APPLIED"], "2026-09-02T00:00:00Z"),
    ]);
    expect(stats.submitted).toBe(3);
    expect(stats.responded).toBe(1);
    expect(stats.responseRate).toBeCloseTo(1 / 3);
    expect(stats.byStage).toMatchObject({ REJECTED: 1, CLOSED: 1, APPLIED: 1 });
  });

  it("does not count a skipped role as submitted", () => {
    const stats = computeDashboard([a("SKIPPED", ["SKIPPED"]), a("APPLIED", ["APPLIED"])]);
    expect(stats.total).toBe(2);
    expect(stats.submitted).toBe(1);
  });

  it("excludes notes-only NOT_APPLIED rows entirely", () => {
    const stats = computeDashboard([a("NOT_APPLIED"), a("APPLIED", ["APPLIED"])]);
    expect(stats.total).toBe(1);
    expect(stats.submitted).toBe(1);
  });

  it("counts an imported row with only an applied date as submitted", () => {
    const stats = computeDashboard([a("CLOSED", [], "2026-08-01T00:00:00Z")]);
    expect(stats.submitted).toBe(1);
    expect(stats.responded).toBe(0);
  });

  it("carries a plain-language definition for the UI", () => {
    expect(computeDashboard([]).definition).toMatch(/Response rate/);
  });
});
