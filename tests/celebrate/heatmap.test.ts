import { describe, expect, it } from "vitest";
import { buildHeatmap, levelFor } from "@/lib/celebrate/heatmap";
import { longestStreak, weekStart } from "@/lib/celebrate/moments";

describe("heatmap", () => {
  it("maps counts to fixed levels", () => {
    expect([0, 1, 2, 3, 4, 6, 7, 30].map(levelFor)).toEqual([0, 1, 2, 2, 3, 3, 4, 4]);
  });

  it("ends with the current week, Monday on top, future days marked", () => {
    // 2026-10-22 is a Thursday.
    const map = buildHeatmap(new Map([["2026-10-22", 2], ["2026-10-21", 1]]), "2026-10-22", 4);
    expect(map.weeks).toHaveLength(4);
    const last = map.weeks.at(-1)!;
    expect(last[0].day).toBe("2026-10-19");
    expect(last[3]).toMatchObject({ day: "2026-10-22", count: 2, level: 2, future: false });
    expect(last[4].future).toBe(true);
    expect(map.total).toBe(3);
    expect(map.activeDays).toBe(2);
    expect(map.currentStreak).toBe(2);
    expect(map.busiest).toEqual({ day: "2026-10-22", count: 2 });
  });

  it("labels a month at the week holding its first day", () => {
    const map = buildHeatmap(new Map(), "2026-10-22", 6);
    // Weeks start 2026-09-14 … 2026-10-19; Oct 1 falls in the week of Sep 28.
    expect(map.monthLabels).toEqual([null, null, "Oct", null, null, null]);
  });

  it("finds week starts and the longest streak", () => {
    expect(weekStart("2026-10-22")).toBe("2026-10-19");
    expect(weekStart("2026-10-19")).toBe("2026-10-19");
    expect(weekStart("2026-10-25")).toBe("2026-10-19");
    expect(longestStreak(new Set(["2026-01-01", "2026-01-02", "2026-01-03", "2026-02-10", "2026-02-11"]))).toBe(3);
    expect(longestStreak(new Set())).toBe(0);
  });
});
