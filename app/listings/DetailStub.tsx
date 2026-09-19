"use client";

import Badge from "@/components/Badge";
import {
  absoluteDay,
  fetchBadge,
  formatScore,
  safeHttpUrl,
  STATUS_FILTER_LABELS,
  type TableRow,
} from "./table-state";

/**
 * STUB detail panel.
 *
 * The real panel — full score breakdown with evidence, resume keyword hits and
 * misses, notes and the status timeline — is the next deliverable. This shows
 * only what the table row already carries, so nothing here has to be unpicked
 * later.
 *
 * Every string on this panel comes from scraped postings and is rendered as
 * text; the apply link goes through `safeHttpUrl` first.
 */
export default function DetailStub({
  row,
  onClose,
}: {
  row: TableRow;
  onClose: () => void;
}) {
  const href = safeHttpUrl(row.url);
  const badge = fetchBadge(row.fetchStatus);

  return (
    <aside
      aria-label="Listing detail"
      className="flex w-[22rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel"
    >
      <header className="sticky top-0 flex items-start gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-ink">{row.company}</div>
          <div className="truncate text-[12px] text-dim">{row.title}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-raised hover:text-ink"
        >
          esc
        </button>
      </header>

      <div className="space-y-3 px-3 py-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xl leading-none text-ink">
            {formatScore(row.score)}
          </span>
          <div className="flex flex-wrap gap-1">
            <Badge tone="dim">rank {row.rank}</Badge>
            {row.llmAdjustment !== null && (
              <Badge tone="info" title="Stage-2 Claude adjustment, clamped to ±15">
                llm {row.llmAdjustment > 0 ? "+" : ""}
                {row.llmAdjustment}
              </Badge>
            )}
            {badge && (
              <Badge tone={badge.tone} title={badge.title} solid>
                {badge.label}
              </Badge>
            )}
          </div>
        </div>

        <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-[12px]">
          <dt className="text-faint">Location</dt>
          <dd className="text-dim">
            {row.location}
            {row.locationCount > 1 ? ` (+${row.locationCount - 1} more)` : ""}
          </dd>
          <dt className="text-faint">Status</dt>
          <dd className="text-dim">{STATUS_FILTER_LABELS[row.statusKey]}</dd>
          <dt className="text-faint">Sources</dt>
          <dd className="text-dim">{row.sources.join(", ") || "—"}</dd>
          <dt className="text-faint">First seen</dt>
          <dd className="font-mono text-dim">
            {absoluteDay(new Date(row.firstSeen).getTime())}
          </dd>
          <dt className="text-faint">Deadline</dt>
          <dd className="font-mono text-dim">
            {row.deadline ? absoluteDay(new Date(row.deadline).getTime()) : "—"}
          </dd>
        </dl>

        {row.disqualified && (
          <p className="rounded border border-bad/40 bg-raised px-2 py-1.5 text-[12px] text-bad">
            Disqualified{row.disqualifyReason ? `: ${row.disqualifyReason}` : ""}
          </p>
        )}

        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center rounded border border-line bg-raised px-2 py-1 text-[12px] text-ink transition-colors hover:border-accent hover:text-accent"
          >
            Open the posting ↗
          </a>
        ) : (
          <p className="text-[12px] text-faint">No usable apply link on this listing.</p>
        )}

        <p className="border-t border-line-soft pt-3 text-[12px] text-faint">
          Full breakdown, resume match and timeline land in the next deliverable.
        </p>
      </div>
    </aside>
  );
}
