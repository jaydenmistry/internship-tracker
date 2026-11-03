"use client";

import { useLayoutEffect, useRef, useState } from "react";
import type { Heatmap as HeatmapData, HeatCell } from "@/lib/celebrate/heatmap";

/**
 * A year of applying, one square per day, darker the more you sent. One hue
 * (the accent) stepping in opacity, on fixed thresholds shown in the legend,
 * so a shade always means the same count. Hovering a day names it in the
 * caption; on a phone the grid scrolls, starting at this week.
 */

const LEVEL_CLASS: Record<HeatCell["level"], string> = {
  0: "bg-raised",
  1: "bg-accent/40",
  2: "bg-accent/60",
  3: "bg-accent/85",
  4: "bg-accent",
};

const LEGEND: Array<[HeatCell["level"], string]> = [
  [0, "none"],
  [1, "1"],
  [2, "2–3"],
  [3, "4–6"],
  [4, "7+"],
];

const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", ""];

function longDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function describe(cell: HeatCell): string {
  const n = cell.count;
  return `${n === 0 ? "No" : n} application${n === 1 ? "" : "s"} on ${longDay(cell.day)}`;
}

export default function Heatmap({ data }: { data: HeatmapData }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<HeatCell | null>(null);

  // Start at the newest week when the grid is wider than the screen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const summary =
    data.total === 0
      ? "No applications in the last year yet. Your first one lights up a square."
      : `${data.total} application${data.total === 1 ? "" : "s"} on ${data.activeDays} day${
          data.activeDays === 1 ? "" : "s"
        } in the last year`;

  return (
    <section aria-labelledby="heatmap-title" className="card flex flex-col gap-3 px-4 py-3.5">
      <header className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id="heatmap-title" className="text-title font-semibold text-ink">
          Your year of applying
        </h2>
        <dl className="flex flex-wrap gap-x-4 gap-y-1 text-callout text-dim">
          <div className="flex gap-1">
            <dt>Current streak</dt>
            <dd className="font-semibold text-ink tabular-nums">
              {data.currentStreak} day{data.currentStreak === 1 ? "" : "s"}
              {data.currentStreak >= 2 ? " 🔥" : ""}
            </dd>
          </div>
          <div className="flex gap-1">
            <dt>Longest</dt>
            <dd className="font-semibold text-ink tabular-nums">
              {data.longestStreak} day{data.longestStreak === 1 ? "" : "s"}
            </dd>
          </div>
          {data.busiest && (
            <div className="flex gap-1">
              <dt>Best day</dt>
              <dd className="font-semibold text-ink tabular-nums">
                {data.busiest.count} on {longDay(data.busiest.day).replace(/^\w+, /, "")}
              </dd>
            </div>
          )}
        </dl>
      </header>

      <div ref={scrollRef} className="overflow-x-auto pb-1">
        <div
          role="img"
          aria-label={`${summary}. Current streak ${data.currentStreak} days, longest ${data.longestStreak} days.`}
          className="inline-grid gap-[3px]"
          style={{ gridTemplateColumns: `1.75rem repeat(${data.weeks.length}, 11px)`, gridTemplateRows: "auto repeat(7, 11px)" }}
          onPointerLeave={() => setHover(null)}
        >
          {/* Month labels across the top. */}
          <span aria-hidden />
          {data.monthLabels.map((label, w) => (
            <span key={`m${w}`} aria-hidden className="h-4 overflow-visible text-footnote whitespace-nowrap text-faint">
              {label}
            </span>
          ))}
          {DAY_LABELS.map((label, d) => (
            <DayRow key={d} label={label} d={d} weeks={data.weeks} onHover={setHover} />
          ))}
        </div>
      </div>

      <footer className="flex flex-wrap items-center justify-between gap-2 text-subhead text-faint">
        <span aria-live="polite" className="min-h-[1lh] text-dim">
          {hover ? describe(hover) : summary}
        </span>
        <span className="flex items-center gap-1" aria-label="Legend: applications per day">
          Less
          {LEGEND.map(([level, label]) => (
            <span key={level} title={label === "none" ? "No applications" : `${label} applications`} className={`size-[11px] rounded-[3px] ${LEVEL_CLASS[level]}`} />
          ))}
          More
        </span>
      </footer>
    </section>
  );
}

function DayRow({
  label,
  d,
  weeks,
  onHover,
}: {
  label: string;
  d: number;
  weeks: HeatCell[][];
  onHover: (cell: HeatCell) => void;
}) {
  return (
    <>
      <span aria-hidden className="pr-1 text-right text-footnote leading-[11px] text-faint">
        {label}
      </span>
      {weeks.map((week) => {
        const cell = week[d];
        if (cell.future) return <span key={cell.day} aria-hidden />;
        return (
          <span
            key={cell.day}
            title={describe(cell)}
            onPointerEnter={() => onHover(cell)}
            className={`size-[11px] rounded-[3px] transition-transform hover:scale-125 ${LEVEL_CLASS[cell.level]}`}
          />
        );
      })}
    </>
  );
}
