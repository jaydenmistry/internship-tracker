"use client";

import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo, useState, type RefObject } from "react";
import Chip from "@/components/Chip";
import type { SavedView } from "@/lib/listings/views";
import FilterMenu, { CheckRow, PanelHeader, RadioRow } from "./FilterMenu";
import ViewsMenu from "./ViewsMenu";
import {
  DEADLINE_FILTER_LABELS,
  describeFilters,
  EMPTY_FILTER,
  facetLabel,
  facetOptions,
  HIGH_SCORE_THRESHOLD,
  POSTED_WITHIN_OPTIONS,
  SORT_PRESETS,
  sortLabel,
  type DeadlineFilter,
  type FacetField,
  type FilterState,
  type SortState,
  type TableRow,
} from "./table-state";

interface Props {
  filter: FilterState;
  onChange: (next: FilterState) => void;
  sort: SortState;
  onSortChange: (next: SortState) => void;
  /** The whole catalog (with optimistic patches) — facet counts are taken over it. */
  rows: readonly TableRow[];
  now: number;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Blur + clear the row cursor; wired to Escape inside the search box. */
  onSearchEscape: () => void;
  shown: number;
  total: number;
  counts: {
    disqualified: number;
    dismissed: number;
    saved: number;
    applied: number;
    closingSoon: number;
    highScore: number;
    fetchIssues: number;
  };
  views: SavedView[];
  currentQuery: string;
  onApplyView: (query: string) => void;
  onViewsChange: (views: SavedView[]) => void;
  onShowHelp: () => void;
}

const inputClass =
  "rounded-md border border-line bg-canvas px-1.5 py-[3px] text-callout text-ink placeholder:text-faint focus:border-accent focus:outline-none";

export default function Toolbar({
  filter,
  onChange,
  sort,
  onSortChange,
  rows,
  now,
  searchRef,
  onSearchEscape,
  shown,
  total,
  counts,
  views,
  currentQuery,
  onApplyView,
  onViewsChange,
  onShowHelp,
}: Props) {
  const set = (patch: Partial<FilterState>) => onChange({ ...filter, ...patch });
  const active = describeFilters(filter);

  const facet = (field: FacetField, label: string) => (
    <FilterMenu label={label} summary={listSummary(field, filter[field])}>
      {() => (
        <FacetPanel
          rows={rows}
          filter={filter}
          field={field}
          now={now}
          onChange={(values) => set({ [field]: values })}
        />
      )}
    </FilterMenu>
  );

  const locationSummary = [
    filter.remoteOnly ? "remote" : null,
    filter.usOnly ? "US" : null,
    filter.locationText.trim() || null,
  ]
    .filter(Boolean)
    .join(", ");

  const scoreSummary =
    filter.minScore !== null && filter.maxScore !== null
      ? `${filter.minScore}–${filter.maxScore}`
      : filter.minScore !== null
        ? `≥ ${filter.minScore}`
        : filter.maxScore !== null
          ? `≤ ${filter.maxScore}`
          : null;

  const moreCount = [
    filter.faangOnly,
    filter.textOnly,
    filter.fetchIssuesOnly,
    filter.showDisqualified,
    filter.showDismissed,
  ].filter(Boolean).length;

  return (
    <div className="shrink-0 border-b border-line bg-canvas">
      {/* Row 1 — search, result count, quick chips, sort, views. */}
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4 pb-2.5">
        <div className="relative">
          <Search aria-hidden size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
          <input
            ref={searchRef}
            type="search"
            value={filter.search}
            placeholder="Search listings"
            aria-label="Search listings"
            title='Every word must match. Put "-" in front of a word to exclude it, e.g. "backend -amazon".'
            onChange={(e) => set({ search: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onSearchEscape();
              }
            }}
            className="h-9 w-80 max-w-[calc(100vw-2rem)] rounded-[10px] border border-transparent bg-raised pr-8 pl-9 text-body text-ink placeholder:text-faint"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-line bg-canvas px-1.5 font-mono text-footnote text-faint">
            /
          </kbd>
        </div>

        <span className="px-1 text-callout text-faint tabular-nums" aria-live="polite">
          <span className="font-semibold text-ink">{shown.toLocaleString("en-US")}</span>
          {" "}of {total.toLocaleString("en-US")}
        </span>

        <span className="mx-1 h-4 w-px bg-line" />

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

      </div>

      {/* Row 2 — one dropdown per filter. Filters combine with AND; boxes
          ticked inside one dropdown combine with OR. */}
      <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3.5 text-callout">
        <SlidersHorizontal aria-hidden size={14} className="mr-1 text-faint" />
        <span className="sr-only">Filter</span>
        {facet("statuses", "Status")}
        {facet("sources", "Source")}
        {facet("categories", "Category")}
        {facet("terms", "Term")}

        <FilterMenu label="Location" summary={locationSummary || null}>
          {() => (
            <div className="w-60">
              <PanelHeader
                hint="Where the role is"
                onClear={
                  locationSummary
                    ? () => set({ remoteOnly: false, usOnly: false, locationText: "" })
                    : null
                }
              />
              <CheckRow checked={filter.remoteOnly} onChange={(v) => set({ remoteOnly: v })}>
                Remote only
              </CheckRow>
              <CheckRow checked={filter.usOnly} onChange={(v) => set({ usOnly: v })}>
                In the US
              </CheckRow>
              <label className="mt-1.5 block px-1 text-subhead text-faint">
                City or state contains
                <input
                  type="text"
                  value={filter.locationText}
                  placeholder="e.g. GA, Atlanta, New York"
                  onChange={(e) => set({ locationText: e.target.value })}
                  className={`mt-1 w-full ${inputClass}`}
                />
              </label>
            </div>
          )}
        </FilterMenu>

        <FilterMenu
          label="Posted"
          summary={
            filter.postedWithinDays === null
              ? null
              : (POSTED_WITHIN_OPTIONS.find((o) => o.days === filter.postedWithinDays)?.label ??
                `last ${filter.postedWithinDays} days`)
          }
        >
          {(close) => (
            <div>
              <PanelHeader hint="Posted (or first seen)" />
              <RadioRow
                name="posted"
                checked={filter.postedWithinDays === null}
                onSelect={() => {
                  set({ postedWithinDays: null });
                  close();
                }}
              >
                any time
              </RadioRow>
              {POSTED_WITHIN_OPTIONS.map((option) => (
                <RadioRow
                  key={option.days}
                  name="posted"
                  checked={filter.postedWithinDays === option.days}
                  onSelect={() => {
                    set({ postedWithinDays: option.days });
                    close();
                  }}
                >
                  {option.label}
                </RadioRow>
              ))}
            </div>
          )}
        </FilterMenu>

        <FilterMenu
          label="Deadline"
          summary={filter.deadline === "any" ? null : DEADLINE_FILTER_LABELS[filter.deadline]}
        >
          {(close) => (
            <div>
              <PanelHeader hint="Application deadline" />
              {(Object.keys(DEADLINE_FILTER_LABELS) as DeadlineFilter[]).map((value) => (
                <RadioRow
                  key={value}
                  name="deadline"
                  checked={filter.deadline === value}
                  onSelect={() => {
                    set({ deadline: value });
                    close();
                  }}
                >
                  {DEADLINE_FILTER_LABELS[value]}
                </RadioRow>
              ))}
            </div>
          )}
        </FilterMenu>

        <FilterMenu label="Score" summary={scoreSummary}>
          {() => (
            <ScorePanel
              minScore={filter.minScore}
              maxScore={filter.maxScore}
              onChange={(minScore, maxScore) => set({ minScore, maxScore })}
            />
          )}
        </FilterMenu>

        <FilterMenu label="More" summary={moreCount ? String(moreCount) : null}>
          {() => (
            <div className="w-64">
              <PanelHeader hint="Other filters" />
              <CheckRow checked={filter.faangOnly} onChange={(v) => set({ faangOnly: v })}>
                FAANG+ companies only
              </CheckRow>
              <CheckRow checked={filter.textOnly} onChange={(v) => set({ textOnly: v })}>
                Has the full posting text
              </CheckRow>
              {(counts.fetchIssues > 0 || filter.fetchIssuesOnly) && (
                <CheckRow
                  tone="warn"
                  checked={filter.fetchIssuesOnly}
                  onChange={(v) => set({ fetchIssuesOnly: v })}
                  count={counts.fetchIssues}
                >
                  Posting couldn&apos;t be fetched
                </CheckRow>
              )}
              <div className="my-1.5 border-t border-line-soft" />
              <CheckRow
                checked={filter.showDisqualified}
                onChange={(v) => set({ showDisqualified: v })}
                count={counts.disqualified}
              >
                Show disqualified
              </CheckRow>
              <CheckRow
                checked={filter.showDismissed}
                onChange={(v) => set({ showDismissed: v })}
                count={counts.dismissed}
              >
                Show dismissed
              </CheckRow>
            </div>
          )}
        </FilterMenu>
        <div className="ml-auto flex items-center gap-2">
          <FilterMenu
            label="Sort"
            summary={sortLabel(sort)}
            active={false}
            align="right"
            title="Sort order — clicking a column header works too"
          >
            {(close) => (
              <div>
                <PanelHeader hint="Sort listings by" />
                {SORT_PRESETS.map((preset) => (
                  <RadioRow
                    key={preset.label}
                    name="sort"
                    checked={preset.sort.key === sort.key && preset.sort.dir === sort.dir}
                    onSelect={() => {
                      onSortChange(preset.sort);
                      close();
                    }}
                  >
                    {preset.label}
                  </RadioRow>
                ))}
                <button
                  type="button"
                  onClick={() => onSortChange({ ...sort, dir: sort.dir === "asc" ? "desc" : "asc" })}
                  className="mt-1.5 w-full rounded-md border border-line px-2 py-1 text-left text-dim hover:bg-raised hover:text-ink"
                >
                  ⇅ Reverse order
                </button>
              </div>
            )}
          </FilterMenu>

          <ViewsMenu
            views={views}
            currentQuery={currentQuery}
            onApply={onApplyView}
            onChange={onViewsChange}
          />

          <button
            type="button"
            onClick={onShowHelp}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            className="flex size-7 items-center justify-center rounded-full border border-line text-callout font-medium text-dim hover:bg-raised hover:text-ink"
          >
            ?
          </button>
        </div>
      </div>

      {/* Row 3 — what is narrowing the view right now, each removable. */}
      {active.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-1.5 border-t border-line-soft px-4 py-2 text-callout"
          aria-label="Active filters"
        >
          {active.map((item) => (
            <span
              key={item.key}
              className="inline-flex items-center gap-1 rounded-full bg-accent/10 py-0.5 pr-1 pl-2.5 text-ink"
            >
              {item.label}
              <button
                type="button"
                aria-label={`Remove filter: ${item.label}`}
                onClick={() => onChange(item.clear(filter))}
                className="rounded-full px-1 text-dim hover:bg-raised hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
          <button
            type="button"
            onClick={() => onChange(EMPTY_FILTER)}
            className="ml-1 rounded px-1.5 py-[1px] text-faint hover:bg-raised hover:text-ink"
          >
            clear all
          </button>
        </div>
      )}
    </div>
  );
}

/** Button summary for a multi-select: the one value, or "N selected". */
function listSummary(field: FacetField, values: readonly string[]): string | null {
  if (values.length === 0) return null;
  return values.length === 1 ? facetLabel(field, values[0]) : `${values.length} selected`;
}

function FacetPanel({
  rows,
  filter,
  field,
  now,
  onChange,
}: {
  rows: readonly TableRow[];
  filter: FilterState;
  field: FacetField;
  now: number;
  onChange: (values: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => facetOptions(rows, filter, field, now), [rows, filter, field, now]);
  const selected = filter[field] as string[];
  const shownOptions = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));

  return (
    <div className="w-64">
      <PanelHeader
        hint={selected.length ? `${selected.length} selected · matches any` : "Tick one or more"}
        onClear={selected.length ? () => onChange([]) : null}
      />
      {options.length > 8 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find…"
          aria-label="Find an option"
          className={`mb-1.5 w-full ${inputClass}`}
        />
      )}
      <ul className="max-h-72 overflow-y-auto">
        {shownOptions.map((option) => (
          <li key={option.value} className="group flex items-center">
            <div className="min-w-0 flex-1">
              <CheckRow
                checked={selected.includes(option.value)}
                onChange={(on) => toggle(option.value, on)}
                count={option.count}
              >
                <span className={option.count === 0 && !selected.includes(option.value) ? "text-faint" : ""}>
                  {option.label}
                </span>
              </CheckRow>
            </div>
            <button
              type="button"
              onClick={() => onChange([option.value])}
              title={`Show only ${option.label}`}
              className="ml-1 rounded px-1 text-footnote text-faint opacity-0 group-hover:opacity-100 hover:text-ink focus:opacity-100"
            >
              only
            </button>
          </li>
        ))}
        {shownOptions.length === 0 && <li className="px-1 py-1 text-faint">No options.</li>}
      </ul>
    </div>
  );
}

function ScorePanel({
  minScore,
  maxScore,
  onChange,
}: {
  minScore: number | null;
  maxScore: number | null;
  onChange: (min: number | null, max: number | null) => void;
}) {
  const parse = (raw: string) => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  };
  return (
    <div className="w-56">
      <PanelHeader
        hint="Score range (0–100)"
        onClear={minScore !== null || maxScore !== null ? () => onChange(null, null) : null}
      />
      <div className="flex items-center gap-1.5 px-1">
        <input
          type="number"
          min={0}
          max={100}
          aria-label="Minimum score"
          placeholder="min"
          value={minScore ?? ""}
          onChange={(e) => onChange(parse(e.target.value), maxScore)}
          className={`w-16 font-mono ${inputClass}`}
        />
        <span className="text-faint">to</span>
        <input
          type="number"
          min={0}
          max={100}
          aria-label="Maximum score"
          placeholder="max"
          value={maxScore ?? ""}
          onChange={(e) => onChange(minScore, parse(e.target.value))}
          className={`w-16 font-mono ${inputClass}`}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-1 px-1">
        {[50, 60, 70, 80].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChange(n, null)}
            className={`rounded border px-1.5 py-[1px] text-subhead ${
              minScore === n && maxScore === null
                ? "border-accent text-ink"
                : "border-line text-dim hover:border-faint hover:text-ink"
            }`}
          >
            {n}+
          </button>
        ))}
      </div>
    </div>
  );
}
