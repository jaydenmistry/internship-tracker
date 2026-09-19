import type { DashboardStats } from "@/lib/applications/tracker";
import { COLUMNS, formatResponseRate, STATUS_LABELS } from "./state";

/**
 * Minimal numbers strip. Deliberately no charts: with a few dozen applications
 * at most, a time series would be mostly empty axes. Every stage is listed,
 * zeros included, so an empty pipeline still reads as a pipeline.
 */
export default function Dashboard({ stats }: { stats: DashboardStats }) {
  const rateKnown = stats.responseRate !== null;
  return (
    <section
      aria-label="Application stats"
      className="flex flex-wrap items-start gap-x-8 gap-y-3 rounded border border-line bg-panel px-3 py-2"
    >
      <dl className="grid grid-cols-4 gap-x-4 gap-y-0.5 sm:grid-cols-8" aria-label="Applications by stage">
        {COLUMNS.map((s) => (
          <div key={s} className="flex flex-col">
            <dt className="text-[11px] whitespace-nowrap text-faint">{STATUS_LABELS[s]}</dt>
            <dd
              className={`font-mono text-[15px] tabular-nums ${
                stats.byStage[s] === 0 ? "text-faint" : "text-ink"
              }`}
            >
              {stats.byStage[s]}
            </dd>
          </div>
        ))}
      </dl>

      <dl className="flex gap-x-4 border-l border-line pl-4" aria-label="Totals">
        {(
          [
            ["total", stats.total],
            ["submitted", stats.submitted],
            ["responded", stats.responded],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-[11px] text-faint">{label}</dt>
            <dd className="font-mono text-[15px] tabular-nums">{n}</dd>
          </div>
        ))}
      </dl>

      <div className="flex min-w-[min(26rem,100%)] flex-1 gap-3 border-l border-line pl-4">
        <dl className="flex shrink-0 flex-col">
          <dt className="text-[11px] text-faint">response rate</dt>
          <dd
            data-testid="response-rate"
            className={
              rateKnown
                ? "font-mono text-[15px] tabular-nums text-ink"
                : "pt-0.5 text-[12px] text-dim italic"
            }
          >
            {formatResponseRate(stats.responseRate)}
          </dd>
        </dl>
        <p className="max-w-xl min-w-0 flex-1 text-[11px] leading-snug text-faint">
          {stats.definition}
        </p>
      </div>
    </section>
  );
}
