"use client";

import { Ellipsis, Search } from "lucide-react";
import type { RefObject } from "react";
import Chip from "@/components/Chip";
import type { SavedView } from "@/lib/listings/views";
import FilterMenu, { PanelHeader, RadioRow } from "./FilterMenu";
import FiltersMenu, { sectionForFilterKey, type FilterSection, type FiltersMenuState } from "./FiltersMenu";
import ViewsMenu from "./ViewsMenu";
import type { Point } from "./context-menu";
import type { ToolbarItemId } from "./table-layout";
import {
  describeFilters,
  EMPTY_FILTER,
  HIGH_SCORE_THRESHOLD,
  SORT_PRESETS,
  sortLabel,
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
  /** Toolbar items the user turned off (right-click the toolbar). */
  hidden: ReadonlySet<ToolbarItemId>;
  onCustomize: (point: Point) => void;
  filtersMenu: FiltersMenuState;
  onFiltersMenu: (next: FiltersMenuState) => void;
}

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
  hidden,
  onCustomize,
  filtersMenu,
  onFiltersMenu,
}: Props) {
  const show = (id: ToolbarItemId) => !hidden.has(id);
  const set = (patch: Partial<FilterState>) => onChange({ ...filter, ...patch });
  const active = describeFilters(filter);
  // A lit quick chip already says it is on; its token would only repeat it.
  const CHIP_OF: Record<string, ToolbarItemId> = {
    saved: "chip-saved",
    applied: "chip-applied",
    closingSoon: "chip-closing",
    highScore: "chip-high",
  };
  const tokens = active.filter((item) => !(item.key in CHIP_OF && show(CHIP_OF[item.key])));
  const openFilters = (section: FilterSection) => onFiltersMenu({ open: true, section, pane: "detail" });

  const anyChip = (["chip-saved", "chip-applied", "chip-closing", "chip-high"] as const).some(show);

  return (
    <div
      data-toolbar=""
      className="shrink-0 border-b border-line bg-canvas"
      // Right-click (or the menu key) anywhere but a text field customizes
      // the toolbar; text fields keep the browser's own menu for copy/paste.
      onContextMenu={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest("input, textarea, [role=dialog]")) return;
        e.preventDefault();
        if (e.clientX === 0 && e.clientY === 0) {
          const r = t.getBoundingClientRect();
          onCustomize({ x: r.left, y: r.bottom + 4 });
        } else onCustomize({ x: e.clientX, y: e.clientY });
      }}
    >
      {/* Search and filters; the count, sort, views and help on the right. */}
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3.5 pb-3">
        {/* On a phone the search field takes the line beside Filters. */}
        <div className="relative min-w-0 flex-1 sm:flex-none">
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
            className="h-9 w-full rounded-[10px] sm:w-80 border border-transparent bg-raised pr-8 pl-9 text-body text-ink placeholder:text-faint"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded-md border border-line bg-canvas px-1.5 font-mono text-footnote text-faint">
            /
          </kbd>
        </div>

        <FiltersMenu
          state={filtersMenu}
          onStateChange={onFiltersMenu}
          filter={filter}
          onChange={onChange}
          rows={rows}
          now={now}
          shown={shown}
          total={total}
          counts={counts}
        />

        <div className="ml-auto flex flex-wrap items-center gap-2">
          {show("count") && (
            <span className="mr-1 whitespace-nowrap text-callout text-faint tabular-nums" aria-live="polite">
              <span className="font-semibold text-ink">{shown.toLocaleString("en-US")}</span> of{" "}
              {total.toLocaleString("en-US")}
            </span>
          )}
          {show("sort") && (
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
          )}

          {show("views") && (
            <ViewsMenu
              views={views}
              currentQuery={currentQuery}
              onApply={onApplyView}
              onChange={onViewsChange}
            />
          )}

          {show("help") && (
            <button
              type="button"
              onClick={onShowHelp}
              title="Keyboard shortcuts"
              aria-label="Keyboard shortcuts"
              className="flex size-7 items-center justify-center rounded-full border border-line text-callout font-medium text-dim hover:bg-raised hover:text-ink"
            >
              ?
            </button>
          )}
          <button
            type="button"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              onCustomize({ x: r.right - 208, y: r.bottom + 6 });
            }}
            title="Choose what the toolbar shows (or right-click it)"
            aria-label="Customize toolbar"
            className="flex size-7 items-center justify-center rounded-full text-faint hover:bg-raised hover:text-ink"
          >
            <Ellipsis aria-hidden size={16} />
          </button>
        </div>
      </div>

      {/* The quick chips, then whatever else is narrowing the view: click a
          token to change it in the filter menu, or × to remove it. */}
      {(anyChip || tokens.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5 px-5 pb-3 text-callout">
          {show("chip-saved") && (
            <Chip
              active={filter.chipSaved}
              onClick={() => set({ chipSaved: !filter.chipSaved })}
              count={counts.saved}
              title="Only listings you saved"
            >
              saved
            </Chip>
          )}
          {show("chip-applied") && (
            <Chip
              active={filter.chipApplied}
              onClick={() => set({ chipApplied: !filter.chipApplied })}
              count={counts.applied}
              title="Applied, OA, phone screen, interview or offer"
            >
              applied
            </Chip>
          )}
          {show("chip-closing") && (
            <Chip
              active={filter.chipClosingSoon}
              onClick={() => set({ chipClosingSoon: !filter.chipClosingSoon })}
              count={counts.closingSoon}
              title="Deadline within 7 days"
            >
              closing soon
            </Chip>
          )}
          {show("chip-high") && (
            <Chip
              active={filter.chipHighScore}
              onClick={() => set({ chipHighScore: !filter.chipHighScore })}
              count={counts.highScore}
              title={`Score ${HIGH_SCORE_THRESHOLD} or above`}
            >
              high score
            </Chip>
          )}

          {anyChip && tokens.length > 0 && <span aria-hidden className="mx-1.5 h-4 w-px bg-line" />}
          {tokens.length > 0 && (
            <div role="group" aria-label="Active filters" className="contents">
              {tokens.map((item) => (
                <span key={item.key} className="token-in inline-flex h-7 items-center rounded-full bg-accent/10 pr-1 text-ink">
                  <button
                    type="button"
                    title={item.key === "search" ? "Edit the search" : "Change in Filters"}
                    onClick={() => {
                      const section = sectionForFilterKey(item.key);
                      if (section) openFilters(section);
                      else searchRef.current?.focus();
                    }}
                    className="h-full rounded-full pr-1 pl-3 hover:text-accent"
                  >
                    {item.label}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove filter: ${item.label}`}
                    onClick={() => onChange(item.clear(filter))}
                    className="flex size-5 items-center justify-center rounded-full text-dim hover:bg-raised hover:text-ink"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {active.length > 0 && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTER)}
              className="ml-1 rounded-md px-2 py-1 text-faint hover:bg-raised hover:text-ink"
            >
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
