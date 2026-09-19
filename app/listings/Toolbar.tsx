"use client";

import type { RefObject } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import Chip from "@/components/Chip";
import {
  EMPTY_FILTER,
  HIGH_SCORE_THRESHOLD,
  isFilterActive,
  STATUS_FILTER_LABELS,
  STATUS_ORDER,
  type DeadlineFilter,
  type FilterState,
} from "./table-state";

interface Props {
  filter: FilterState;
  onChange: (next: FilterState) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Blur + clear the row cursor; wired to Escape inside the search box. */
  onSearchEscape: () => void;
  shown: number;
  total: number;
  sources: string[];
  counts: {
    disqualified: number;
    dismissed: number;
    saved: number;
    applied: number;
    closingSoon: number;
    highScore: number;
    fetchIssues: number;
  };
  onShowHelp: () => void;
}

const selectClass =
  "rounded border border-line bg-panel px-1.5 py-[3px] text-[12px] text-dim hover:border-faint focus:text-ink";

export default function Toolbar({
  filter,
  onChange,
  searchRef,
  onSearchEscape,
  shown,
  total,
  sources,
  counts,
  onShowHelp,
}: Props) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filter, ...patch });

  return (
    <div className="shrink-0 border-b border-line bg-panel">
      {/* Row 1 — search, result count, the four quick chips. */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-1.5">
        <div className="relative">
          <input
            ref={searchRef}
            type="search"
            value={filter.search}
            placeholder="Search company, role, location…"
            aria-label="Search listings"
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onSearchEscape();
              }
            }}
            className="w-72 rounded border border-line bg-canvas py-[3px] pr-8 pl-2 text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm border border-line px-1 font-mono text-[10px] text-faint">
            /
          </kbd>
        </div>

        <span className="font-mono text-[12px] text-dim tabular-nums">
          <span className="text-ink">{shown.toLocaleString("en-US")}</span>
          <span className="text-faint"> of {total.toLocaleString("en-US")}</span>
        </span>

        <span className="h-4 w-px bg-line" />

        <Chip
          active={filter.chipSaved}
          onClick={() => set({ chipSaved: !filter.chipSaved })}
          count={counts.saved}
          title="Only listings you saved"
        >
          saved
        </Chip>
        <Chip
          active={filter.chipApplied}
          onClick={() => set({ chipApplied: !filter.chipApplied })}
          count={counts.applied}
          title="Applied, OA, phone screen, interview or offer"
        >
          applied
        </Chip>
        <Chip
          active={filter.chipClosingSoon}
          onClick={() => set({ chipClosingSoon: !filter.chipClosingSoon })}
          count={counts.closingSoon}
          title="Deadline within 7 days"
        >
          closing soon
        </Chip>
        <Chip
          active={filter.chipHighScore}
          onClick={() => set({ chipHighScore: !filter.chipHighScore })}
          count={counts.highScore}
          title={`Score ${HIGH_SCORE_THRESHOLD} or above`}
        >
          high score
        </Chip>

        <div className="ml-auto flex items-center gap-2">
          {isFilterActive(filter) && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTER)}
              className="rounded px-1.5 py-[3px] text-[12px] text-faint hover:bg-raised hover:text-ink"
            >
              reset
            </button>
          )}
          <button
            type="button"
            onClick={onShowHelp}
            title="Keyboard shortcuts"
            className="rounded border border-line px-1.5 py-[2px] font-mono text-[12px] text-faint hover:border-faint hover:text-ink"
          >
            ?
          </button>
        </div>
      </div>

      {/* Row 2 — per-column filters and the two "show the hidden pile" toggles. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-line-soft px-3 py-1.5 text-[12px]">
        <label className="flex items-center gap-1 text-faint">
          status
          <select
            aria-label="Filter by status"
            className={selectClass}
            value={filter.statuses[0] ?? ""}
            onChange={(e) =>
              set({ statuses: e.target.value ? [e.target.value as AppStatus] : [] })
            }
          >
            <option value="">any</option>
            {STATUS_ORDER.map((s) => (
              <option key={s} value={s}>
                {STATUS_FILTER_LABELS[s]}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-faint">
          source
          <select
            aria-label="Filter by source"
            className={selectClass}
            value={filter.sources[0] ?? ""}
            onChange={(e) => set({ sources: e.target.value ? [e.target.value] : [] })}
          >
            <option value="">any</option>
            {sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-1 text-faint">
          score
          <input
            type="number"
            aria-label="Minimum score"
            placeholder="min"
            value={filter.minScore ?? ""}
            onChange={(e) =>
              set({ minScore: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="w-14 rounded border border-line bg-canvas px-1.5 py-[3px] font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
          <span className="text-faint">–</span>
          <input
            type="number"
            aria-label="Maximum score"
            placeholder="max"
            value={filter.maxScore ?? ""}
            onChange={(e) =>
              set({ maxScore: e.target.value === "" ? null : Number(e.target.value) })
            }
            className="w-14 rounded border border-line bg-canvas px-1.5 py-[3px] font-mono text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
          />
        </label>

        <label className="flex items-center gap-1 text-faint">
          deadline
          <select
            aria-label="Filter by deadline"
            className={selectClass}
            value={filter.deadline}
            onChange={(e) => set({ deadline: e.target.value as DeadlineFilter })}
          >
            <option value="any">any</option>
            <option value="has">has one</option>
            <option value="none">none</option>
          </select>
        </label>

        <span className="h-4 w-px bg-line" />

        <Toggle
          checked={filter.showDisqualified}
          onChange={(v) => set({ showDisqualified: v })}
          label={`show disqualified (${counts.disqualified.toLocaleString("en-US")})`}
        />
        <Toggle
          checked={filter.showDismissed}
          onChange={(v) => set({ showDismissed: v })}
          label={`show dismissed (${counts.dismissed.toLocaleString("en-US")})`}
        />

        {counts.fetchIssues > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 text-warn">
            <input
              type="checkbox"
              checked={filter.fetchIssuesOnly}
              onChange={(e) => set({ fetchIssuesOnly: e.target.checked })}
              className="accent-[var(--warn)]"
            />
            <span
              title="Listings whose posting text could not be fetched — their score is text-independent, not low-quality"
            >
              couldn&apos;t fetch ({counts.fetchIssues.toLocaleString("en-US")})
            </span>
          </label>
        )}
      </div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-1.5 text-faint hover:text-dim">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--accent)]"
      />
      {label}
    </label>
  );
}
