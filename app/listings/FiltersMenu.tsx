"use client";

import { ChevronLeft, ChevronRight, SlidersHorizontal } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { CheckRow, RadioRow } from "./FilterMenu";
import {
  DEADLINE_FILTER_LABELS,
  EMPTY_FILTER,
  facetLabel,
  facetOptions,
  HIGH_SCORE_THRESHOLD,
  POSTED_WITHIN_OPTIONS,
  type DeadlineFilter,
  type FacetField,
  type FilterState,
  type TableRow,
} from "./table-state";

/**
 * Every filter in one place: a button beside the search field that opens a
 * popover with the filter sections listed on the left and the chosen one's
 * options on the right. At phone width the popover becomes a sheet, and the
 * list drills into one section at a time.
 *
 * Changes apply as they are made, so the table behind it (and the count in
 * the footer) answers each tick; the popover stays open for several picks and
 * closes on Done, Escape or a click outside. Its body keeps one height
 * whichever section is showing, so moving between sections never makes it
 * jump. Keystrokes inside it never reach the table's single-key shortcuts.
 */

export type FilterSection =
  | "quick"
  | "statuses"
  | "sources"
  | "categories"
  | "terms"
  | "location"
  | "posted"
  | "deadline"
  | "score"
  | "other";

export interface FiltersMenuState {
  open: boolean;
  /** Remembered while closed, so the menu reopens where it was left. */
  section: FilterSection;
  /** Phone width only: the section list, or one section's options. */
  pane: "list" | "detail";
}

export const FILTERS_MENU_CLOSED: FiltersMenuState = { open: false, section: "quick", pane: "list" };

const SECTIONS: ReadonlyArray<{ id: FilterSection; label: string; hint: string }> = [
  { id: "quick", label: "Quick filters", hint: "The same as the buttons beside the search field." },
  { id: "statuses", label: "Status", hint: "Your application status. Ticked statuses match any." },
  { id: "sources", label: "Source", hint: "Where the listing was found. Ticked sources match any." },
  { id: "categories", label: "Category", hint: "Kind of role. Ticked categories match any." },
  { id: "terms", label: "Term", hint: "When the internship runs. Ticked terms match any." },
  { id: "location", label: "Location", hint: "Where the role is." },
  { id: "posted", label: "Posted", hint: "When it was posted, or first seen." },
  { id: "deadline", label: "Deadline", hint: "The application deadline." },
  { id: "score", label: "Score", hint: "How well it fits your profile, 0 to 100." },
  { id: "other", label: "Other", hint: "Posting text, and what the table hides by default." },
];

const FACETS: Partial<Record<FilterSection, FacetField>> = {
  statuses: "statuses",
  sources: "sources",
  categories: "categories",
  terms: "terms",
};

/** Which section holds an active-filter token (`describeFilters` keys). */
const SECTION_OF_KEY: Record<string, FilterSection> = {
  saved: "quick",
  applied: "quick",
  closingSoon: "quick",
  highScore: "quick",
  statuses: "statuses",
  sources: "sources",
  categories: "categories",
  terms: "terms",
  remote: "location",
  us: "location",
  locationText: "location",
  posted: "posted",
  deadline: "deadline",
  score: "score",
  faang: "other",
  text: "other",
  fetch: "other",
  dq: "other",
  dismissed: "other",
};

export function sectionForFilterKey(key: string): FilterSection | null {
  return SECTION_OF_KEY[key] ?? null;
}

/** What a section is set to, in a few words — or null when it is unset. */
export function sectionSummary(section: FilterSection, filter: FilterState): string | null {
  const facet = FACETS[section];
  if (facet) {
    const values = filter[facet];
    if (values.length === 0) return null;
    return values.length === 1 ? facetLabel(facet, values[0]) : `${values.length} selected`;
  }
  switch (section) {
    case "quick": {
      const on = [
        filter.chipSaved && "Saved",
        filter.chipApplied && "Applied",
        filter.chipClosingSoon && "Closing soon",
        filter.chipHighScore && "High score",
      ].filter(Boolean);
      return on.length === 0 ? null : on.length === 1 ? (on[0] as string) : `${on.length} on`;
    }
    case "location":
      return (
        [filter.remoteOnly && "Remote", filter.usOnly && "US", filter.locationText.trim()].filter(Boolean).join(", ") ||
        null
      );
    case "posted":
      return filter.postedWithinDays === null
        ? null
        : (POSTED_WITHIN_OPTIONS.find((o) => o.days === filter.postedWithinDays)?.label ??
            `last ${filter.postedWithinDays} days`);
    case "deadline":
      return filter.deadline === "any" ? null : DEADLINE_FILTER_LABELS[filter.deadline];
    case "score": {
      const { minScore: lo, maxScore: hi } = filter;
      if (lo !== null && hi !== null) return `${Math.min(lo, hi)}–${Math.max(lo, hi)}`;
      if (lo !== null) return `${lo} or more`;
      if (hi !== null) return `${hi} or less`;
      return null;
    }
    case "other": {
      const n = [filter.faangOnly, filter.textOnly, filter.fetchIssuesOnly, filter.showDisqualified, filter.showDismissed]
        .filter(Boolean).length;
      return n ? `${n} on` : null;
    }
    default:
      return null;
  }
}

/** The fields a section's Clear resets. */
function sectionReset(section: FilterSection): Partial<FilterState> {
  const facet = FACETS[section];
  if (facet) return { [facet]: [] };
  switch (section) {
    case "quick":
      return { chipSaved: false, chipApplied: false, chipClosingSoon: false, chipHighScore: false };
    case "location":
      return { remoteOnly: false, usOnly: false, locationText: "" };
    case "posted":
      return { postedWithinDays: null };
    case "deadline":
      return { deadline: "any" };
    case "score":
      return { minScore: null, maxScore: null };
    case "other":
      return { faangOnly: false, textOnly: false, fetchIssuesOnly: false, showDisqualified: false, showDismissed: false };
    default:
      return {};
  }
}

/** How many sections are narrowing the view — the number on the button. */
export function activeSectionCount(filter: FilterState): number {
  return SECTIONS.filter((s) => sectionSummary(s.id, filter) !== null).length;
}

/** Matches the sheet breakpoint in globals.css (.fm-pop). */
const COMPACT_QUERY = "(max-width: 39.99rem)";
const isCompact = () => window.matchMedia(COMPACT_QUERY).matches;

const inputClass =
  "rounded-md border border-line bg-canvas px-2 py-1 text-callout text-ink placeholder:text-faint focus:border-accent focus:outline-none";

interface Props {
  state: FiltersMenuState;
  onStateChange: (next: FiltersMenuState) => void;
  filter: FilterState;
  onChange: (next: FilterState) => void;
  /** The whole catalog (with optimistic patches) — option counts come from it. */
  rows: readonly TableRow[];
  now: number;
  shown: number;
  total: number;
  counts: {
    saved: number;
    applied: number;
    closingSoon: number;
    highScore: number;
    disqualified: number;
    dismissed: number;
    fetchIssues: number;
  };
}

export default function FiltersMenu({ state, onStateChange, filter, onChange, rows, now, shown, total, counts }: Props) {
  const { open, section, pane } = state;
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const buttonId = `${id}-button`;
  const backId = `${id}-back`;
  const tabId = (s: FilterSection) => `${id}-tab-${s}`;
  const panelId = `${id}-panel`;

  const set = (patch: Partial<FilterState>) => onChange({ ...filter, ...patch });
  const active = activeSectionCount(filter);
  const current = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0];
  const currentSummary = sectionSummary(section, filter);

  const close = (returnFocus: boolean) => {
    onStateChange({ ...state, open: false });
    if (returnFocus) document.getElementById(buttonId)?.focus();
  };

  // Outside pointerdown closes it, like any popover — the changes are
  // already applied, so nothing is lost.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) onStateChange({ ...state, open: false });
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, state, onStateChange]);

  // Keep the popover on screen: it opens under the button and slides left
  // when the button sits too close to the right edge.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!open || !pop) return;
    pop.style.setProperty("--fm-shift", "0px");
    // offsetWidth, not the bounding box: the pop-in animation is scaling it.
    const left = pop.getBoundingClientRect().left;
    const overflow = left + pop.offsetWidth - (window.innerWidth - 16);
    if (overflow > 0) pop.style.setProperty("--fm-shift", `${-Math.min(overflow, left - 16)}px`);
  }, [open]);

  // Focus follows the view: the chosen section in the list, or — on a phone,
  // once a section is open — its back button.
  useEffect(() => {
    if (!open) return;
    const target = pane === "detail" && isCompact() ? backId : tabId(section);
    document.getElementById(target)?.focus({ preventScroll: true });
    // tabId is derived from `id`, which never changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane, section, backId]);

  function onListKeyDown(event: ReactKeyboardEvent) {
    const at = SECTIONS.findIndex((s) => s.id === section);
    const focused = SECTIONS.findIndex((s) => tabId(s.id) === (document.activeElement as HTMLElement | null)?.id);
    const from = focused === -1 ? at : focused;
    let next: number | null = null;
    if (event.key === "ArrowDown") next = Math.min(SECTIONS.length - 1, from + 1);
    else if (event.key === "ArrowUp") next = Math.max(0, from - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = SECTIONS.length - 1;
    if (next === null) return;
    event.preventDefault();
    const target = SECTIONS[next].id;
    // Side by side, moving through the list shows each section as it goes;
    // on a phone it only moves focus, and Enter opens the section.
    if (isCompact()) document.getElementById(tabId(target))?.focus();
    else onStateChange({ ...state, section: target, pane: "detail" });
  }

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (!open) return;
        // The popover owns the keyboard while it is open.
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close(true);
        }
      }}
    >
      <button
        id={buttonId}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-pop` : undefined}
        title="Filters (F)"
        onClick={() => (open ? close(false) : onStateChange({ ...state, open: true, pane: "list" }))}
        className={`inline-flex h-9 items-center gap-1.5 rounded-[10px] px-3 text-body transition-colors ${
          active || open ? "bg-accent/10 text-accent" : "bg-raised text-dim hover:text-ink"
        }`}
      >
        <SlidersHorizontal aria-hidden size={15} />
        <span className={active ? "font-medium" : ""}>Filters</span>
        {active > 0 && (
          <span className="min-w-[1.125rem] rounded-full bg-accent px-1 text-center text-footnote leading-[1.125rem] font-semibold text-accent-ink tabular-nums">
            {active}
            <span className="sr-only"> active</span>
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Dims the table behind the sheet at phone width; hidden otherwise. */}
          <div aria-hidden className="fm-scrim fade-in" onClick={() => close(true)} />
          <div
            ref={popRef}
            id={`${id}-pop`}
            role="dialog"
            aria-label="Filters"
            data-pane={pane}
            className="fm-pop flex flex-col overflow-hidden border border-line bg-panel/95 text-callout shadow-xl backdrop-blur-xl"
          >
            <span aria-hidden className="fm-grabber" />
            <div className="fm-body flex min-h-0 flex-1">
              {/* Section list */}
              <div
                role="tablist"
                aria-orientation="vertical"
                aria-label="Filter sections"
                onKeyDown={onListKeyDown}
                className="fm-list flex w-48 shrink-0 flex-col gap-px overflow-y-auto border-r border-line-soft p-2"
              >
                <p className="fm-sheet-title px-2 pt-1 pb-2 text-title font-semibold text-ink">Filters</p>
                {SECTIONS.map((s) => {
                  const summary = sectionSummary(s.id, filter);
                  const selected = s.id === section;
                  return (
                    <button
                      key={s.id}
                      id={tabId(s.id)}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-controls={panelId}
                      tabIndex={selected ? 0 : -1}
                      onClick={() => onStateChange({ ...state, section: s.id, pane: "detail" })}
                      className={`fm-tab flex min-h-8 items-center gap-2 rounded-lg px-2.5 text-left transition-colors ${
                        selected ? "bg-raised text-ink" : "text-dim hover:bg-raised/60 hover:text-ink"
                      }`}
                    >
                      <span className="shrink-0">{s.label}</span>
                      <span
                        className={`ml-auto min-w-0 truncate text-subhead ${summary ? "text-accent" : "text-faint"}`}
                      >
                        {summary ?? ""}
                      </span>
                      <ChevronRight aria-hidden size={14} className="fm-chevron shrink-0 text-faint" />
                    </button>
                  );
                })}
              </div>

              {/* The chosen section */}
              <div
                id={panelId}
                role="tabpanel"
                aria-labelledby={tabId(section)}
                className="fm-detail flex min-w-0 flex-1 flex-col"
              >
                <div className="flex items-start gap-2 px-4 pt-3.5 pb-2.5">
                  <button
                    id={backId}
                    type="button"
                    aria-label="All filters"
                    onClick={() => onStateChange({ ...state, pane: "list" })}
                    className="fm-back -ml-2 size-8 shrink-0 items-center justify-center rounded-full text-accent hover:bg-raised"
                  >
                    <ChevronLeft aria-hidden size={20} />
                  </button>
                  <div className="min-w-0 flex-1">
                    <h3 className="text-title font-semibold text-ink">{current.label}</h3>
                    <p className="mt-0.5 text-subhead text-faint">{current.hint}</p>
                  </div>
                  {currentSummary !== null && (
                    <button
                      type="button"
                      onClick={() => set(sectionReset(section))}
                      className="shrink-0 rounded-md px-2 py-1 text-callout text-accent hover:bg-raised"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div key={section} className="fm-options content-in min-h-0 flex-1 overflow-y-auto px-3 pb-3">
                  <SectionBody section={section} filter={filter} set={set} rows={rows} now={now} counts={counts} />
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 border-t border-line-soft px-4 py-2.5">
              <span className="min-w-0 flex-1 truncate text-subhead text-faint tabular-nums" aria-live="polite">
                <span className="font-semibold text-ink">{shown.toLocaleString("en-US")}</span> of{" "}
                {total.toLocaleString("en-US")} listings
              </span>
              <button
                type="button"
                disabled={active === 0}
                onClick={() => onChange({ ...EMPTY_FILTER, search: filter.search })}
                className="rounded-lg px-2.5 py-1.5 text-callout text-dim hover:bg-raised hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                Clear all
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                className="rounded-lg bg-accent-fill px-3.5 py-1.5 text-callout font-medium text-accent-ink hover:opacity-90"
              >
                Done
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function SectionBody({
  section,
  filter,
  set,
  rows,
  now,
  counts,
}: {
  section: FilterSection;
  filter: FilterState;
  set: (patch: Partial<FilterState>) => void;
  rows: readonly TableRow[];
  now: number;
  counts: Props["counts"];
}) {
  const facet = FACETS[section];
  if (facet) {
    return (
      <FacetOptions
        key={facet}
        rows={rows}
        filter={filter}
        field={facet}
        now={now}
        onChange={(values) => set({ [facet]: values })}
      />
    );
  }

  switch (section) {
    case "quick":
      return (
        <div>
          <CheckRow checked={filter.chipSaved} onChange={(v) => set({ chipSaved: v })} count={counts.saved}>
            <Labelled detail="Listings you saved">Saved</Labelled>
          </CheckRow>
          <CheckRow checked={filter.chipApplied} onChange={(v) => set({ chipApplied: v })} count={counts.applied}>
            <Labelled detail="Applied, OA, phone screen, interview or offer">Applied</Labelled>
          </CheckRow>
          <CheckRow
            checked={filter.chipClosingSoon}
            onChange={(v) => set({ chipClosingSoon: v })}
            count={counts.closingSoon}
          >
            <Labelled detail="Deadline within 7 days">Closing soon</Labelled>
          </CheckRow>
          <CheckRow checked={filter.chipHighScore} onChange={(v) => set({ chipHighScore: v })} count={counts.highScore}>
            <Labelled detail={`Score ${HIGH_SCORE_THRESHOLD} or above`}>High score</Labelled>
          </CheckRow>
        </div>
      );

    case "location":
      return (
        <div>
          <CheckRow checked={filter.remoteOnly} onChange={(v) => set({ remoteOnly: v })}>
            Remote only
          </CheckRow>
          <CheckRow checked={filter.usOnly} onChange={(v) => set({ usOnly: v })}>
            In the US
          </CheckRow>
          <label className="mt-3 block px-1.5 text-subhead text-faint">
            City or state contains
            <input
              type="text"
              value={filter.locationText}
              placeholder="e.g. GA, Atlanta, New York"
              onChange={(e) => set({ locationText: e.target.value })}
              className={`mt-1.5 w-full ${inputClass}`}
            />
          </label>
        </div>
      );

    case "posted":
      return (
        <div role="radiogroup" aria-label="Posted">
          <RadioRow name="fm-posted" checked={filter.postedWithinDays === null} onSelect={() => set({ postedWithinDays: null })}>
            Any time
          </RadioRow>
          {POSTED_WITHIN_OPTIONS.map((option) => (
            <RadioRow
              key={option.days}
              name="fm-posted"
              checked={filter.postedWithinDays === option.days}
              onSelect={() => set({ postedWithinDays: option.days })}
            >
              {capitalize(option.label)}
            </RadioRow>
          ))}
        </div>
      );

    case "deadline":
      return (
        <div role="radiogroup" aria-label="Deadline">
          {(Object.keys(DEADLINE_FILTER_LABELS) as DeadlineFilter[]).map((value) => (
            <RadioRow
              key={value}
              name="fm-deadline"
              checked={filter.deadline === value}
              onSelect={() => set({ deadline: value })}
            >
              {capitalize(DEADLINE_FILTER_LABELS[value])}
            </RadioRow>
          ))}
        </div>
      );

    case "score":
      return <ScoreOptions minScore={filter.minScore} maxScore={filter.maxScore} set={set} />;

    case "other":
      return (
        <div>
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
          <p className="mt-3 mb-1 px-1.5 text-footnote font-medium tracking-wide text-faint uppercase">
            Hidden by default
          </p>
          <CheckRow
            checked={filter.showDisqualified}
            onChange={(v) => set({ showDisqualified: v })}
            count={counts.disqualified}
          >
            <Labelled detail="Roles a disqualifier scored 0">Show disqualified</Labelled>
          </CheckRow>
          <CheckRow checked={filter.showDismissed} onChange={(v) => set({ showDismissed: v })} count={counts.dismissed}>
            <Labelled detail="Listings you dismissed">Show dismissed</Labelled>
          </CheckRow>
        </div>
      );

    default:
      return null;
  }
}

/** A row label with a line of explanation under it. */
function Labelled({ detail, children }: { detail: string; children: ReactNode }) {
  return (
    <span className="block py-0.5">
      <span className="block">{children}</span>
      <span className="block text-subhead text-faint">{detail}</span>
    </span>
  );
}

function capitalize(text: string): string {
  return text.replace(/^./, (c) => c.toUpperCase());
}

function FacetOptions({
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
  const q = query.trim().toLowerCase();
  const shownOptions = q ? options.filter((o) => o.label.toLowerCase().includes(q)) : options;

  const toggle = (value: string, on: boolean) =>
    onChange(on ? [...selected, value] : selected.filter((v) => v !== value));

  return (
    <div>
      {options.length > 8 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find"
          aria-label="Find an option"
          className={`mb-2 w-full ${inputClass}`}
        />
      )}
      <ul>
        {shownOptions.map((option) => {
          const on = selected.includes(option.value);
          return (
            <li key={option.value} className="group flex items-center">
              <div className="min-w-0 flex-1">
                <CheckRow checked={on} onChange={(v) => toggle(option.value, v)} count={option.count}>
                  <span className={option.count === 0 && !on ? "text-faint" : ""}>{option.label}</span>
                </CheckRow>
              </div>
              <button
                type="button"
                onClick={() => onChange([option.value])}
                title={`Show only ${option.label}`}
                className="ml-1 rounded-md px-1.5 py-0.5 text-subhead text-accent opacity-0 group-hover:opacity-100 hover:bg-raised focus:opacity-100"
              >
                Only
              </button>
            </li>
          );
        })}
        {shownOptions.length === 0 && (
          <li className="px-1.5 py-2 text-faint">{q ? `Nothing matches “${query.trim()}”.` : "No options yet."}</li>
        )}
      </ul>
    </div>
  );
}

const SCORE_PRESETS = [50, 60, 70, 80];

function ScoreOptions({
  minScore,
  maxScore,
  set,
}: {
  minScore: number | null;
  maxScore: number | null;
  set: (patch: Partial<FilterState>) => void;
}) {
  const parse = (raw: string) => {
    if (raw.trim() === "") return null;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
  };
  return (
    <div className="px-1.5">
      <p className="mb-1.5 text-subhead text-faint">At least</p>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Minimum score presets">
        {SCORE_PRESETS.map((n) => {
          const on = minScore === n && maxScore === null;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={on}
              onClick={() => set({ minScore: on ? null : n, maxScore: null })}
              className={`h-8 min-w-12 rounded-full border px-3 text-callout tabular-nums transition-colors ${
                on
                  ? "border-accent/40 bg-accent/10 font-medium text-accent"
                  : "border-line text-dim hover:bg-raised hover:text-ink"
              }`}
            >
              {n}+
            </button>
          );
        })}
      </div>
      <p className="mt-4 mb-1.5 text-subhead text-faint">Or a custom range</p>
      <div className="flex items-center gap-2">
        <input
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          aria-label="Minimum score"
          placeholder="0"
          value={minScore ?? ""}
          onChange={(e) => set({ minScore: parse(e.target.value) })}
          className={`w-20 tabular-nums ${inputClass}`}
        />
        <span className="text-faint">to</span>
        <input
          type="number"
          min={0}
          max={100}
          inputMode="numeric"
          aria-label="Maximum score"
          placeholder="100"
          value={maxScore ?? ""}
          onChange={(e) => set({ maxScore: parse(e.target.value) })}
          className={`w-20 tabular-nums ${inputClass}`}
        />
      </div>
    </div>
  );
}
