import { addDays, longestStreak, streakLength, weekStart } from "./moments";

/**
 * The activity heatmap's grid: one column per week (Monday on top), ending
 * with the current week, one cell per day. Pure, so the server renders it and
 * the levels are testable.
 */

export interface HeatCell {
  day: string;
  count: number;
  /** 0 (none) to 4 (busiest), on fixed thresholds so a level always means the same amount. */
  level: 0 | 1 | 2 | 3 | 4;
  /** After today: drawn empty, not as a zero. */
  future: boolean;
}

export interface Heatmap {
  weeks: HeatCell[][];
  /** "Oct", at the first week a month starts in, else null. */
  monthLabels: Array<string | null>;
  total: number;
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
  busiest: { day: string; count: number } | null;
}

export function levelFor(count: number): HeatCell["level"] {
  if (count <= 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 6) return 3;
  return 4;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function buildHeatmap(perDay: ReadonlyMap<string, number>, today: string, weekCount = 53): Heatmap {
  const first = addDays(weekStart(today), -7 * (weekCount - 1));
  const weeks: HeatCell[][] = [];
  const monthLabels: Array<string | null> = [];
  let total = 0;
  let activeDays = 0;
  let busiest: Heatmap["busiest"] = null;

  for (let w = 0; w < weekCount; w++) {
    const column: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const day = addDays(first, w * 7 + d);
      const future = day > today;
      const count = future ? 0 : (perDay.get(day) ?? 0);
      if (count > 0) {
        total += count;
        activeDays += 1;
        if (!busiest || count > busiest.count) busiest = { day, count };
      }
      column.push({ day, count, level: levelFor(count), future });
    }
    weeks.push(column);
    // Label a month at the week holding its 1st, so labels never crowd.
    const firstOfMonth = column.find((c) => c.day.endsWith("-01"));
    monthLabels.push(w > 0 && firstOfMonth ? MONTHS[Number(firstOfMonth.day.slice(5, 7)) - 1] : null);
  }

  const days = new Set([...perDay.entries()].filter(([day, n]) => n > 0 && day <= today).map(([day]) => day));
  return {
    weeks,
    monthLabels,
    total,
    activeDays,
    currentStreak: streakLength(days, today),
    longestStreak: longestStreak(days),
    busiest,
  };
}
