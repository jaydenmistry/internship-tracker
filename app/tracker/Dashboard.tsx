import type { DashboardStats } from "@/lib/applications/tracker";
import { COLUMNS, formatResponseRate, STATUS_LABELS, STATUS_TONE } from "./state";

/**
 * Headline numbers, then the pipeline. Deliberately no charts: with a few
 * dozen applications at most, a time series would be mostly empty axes.
 * Every stage is listed, zeros included, so an empty pipeline still reads as
 * a pipeline.
 */
export default function Dashboard({ stats }: { stats: DashboardStats }) {
  const rateKnown = stats.responseRate !== null;
  const tiles: Array<[string, number]> = [
    ["Applications", stats.total],
    ["Submitted", stats.submitted],
    ["Responded", stats.responded],
  ];
  return (
    <section aria-label="Application stats" className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Totals">
        {tiles.map(([label, n]) => (
          <div key={label} className="card px-4 py-3">
            <dt className="text-callout text-dim">{label}</dt>
            <dd className={`mt-0.5 text-large leading-tight font-semibold tabular-nums ${n === 0 ? "text-faint" : "text-ink"}`}>
              {n}
            </dd>
          </div>
        ))}
        <div className="card px-4 py-3" title={stats.definition}>
          <dt className="text-callout text-dim">Response rate</dt>
          <dd
            data-testid="response-rate"
            className={
              rateKnown
                ? "mt-0.5 text-large leading-tight font-semibold tabular-nums text-ink"
                : "mt-1.5 text-body text-faint"
            }
          >
            {formatResponseRate(stats.responseRate)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1.5">
        <dl className="flex flex-wrap gap-1.5" aria-label="Applications by stage">
          {COLUMNS.map((s) => (
            <div
              key={s}
              className={`flex items-center gap-1.5 rounded-full border border-line-soft bg-panel py-1 pr-2.5 pl-2 text-callout ${
                stats.byStage[s] === 0 ? "text-faint" : "text-ink"
              }`}
            >
              <span aria-hidden className={`size-1.5 rounded-full bg-current ${STATUS_TONE[s]}`} />
              <dt className="whitespace-nowrap">{STATUS_LABELS[s]}</dt>
              <dd className="font-semibold tabular-nums">{stats.byStage[s]}</dd>
            </div>
          ))}
        </dl>
        <p className="max-w-3xl text-subhead leading-snug text-faint">{stats.definition}</p>
      </div>
    </section>
  );
}
