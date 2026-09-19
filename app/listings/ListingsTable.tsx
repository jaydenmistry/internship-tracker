"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Badge from "@/components/Badge";
import type { ListingRow } from "@/lib/listings/query";
import ContextMenu from "./ContextMenu";
import DetailPanel from "./DetailPanel";
import HelpOverlay from "./HelpOverlay";
import { isActivatable, isEditable, isPlainKey } from "./keys";
import type { RowCommand, Toast } from "./row-actions";
import Toolbar from "./Toolbar";
import {
  absoluteDate,
  absoluteDay,
  applyPatches,
  allSources,
  DEFAULT_SORT,
  deadlineUrgency,
  dqBadge,
  EMPTY_FILTER,
  fetchBadge,
  formatDeadline,
  formatScore,
  HIGH_SCORE_THRESHOLD,
  isClosingSoon,
  isTrackedApplied,
  nextSort,
  prepareRows,
  rankMovement,
  relativeAge,
  scoreTone,
  sortRows,
  STATUS_LABELS,
  makeRowPredicate,
  type FilterState,
  type SortKey,
  type SortState,
  type TableRow,
} from "./table-state";
import { useListingDetail } from "./useListingDetail";
import { useRowActions } from "./useRowActions";

/** Fixed row height — the virtualizer measures nothing, so cells never wrap. */
const ROW_HEIGHT = 26;

const COLUMNS: Array<{ key: SortKey; label: string; align?: "right" }> = [
  { key: "rank", label: "#", align: "right" },
  { key: "score", label: "score", align: "right" },
  { key: "company", label: "company" },
  { key: "role", label: "role" },
  { key: "location", label: "location" },
  { key: "age", label: "age", align: "right" },
  { key: "deadline", label: "deadline" },
  { key: "status", label: "status" },
  { key: "source", label: "source" },
];

interface Props {
  rows: ListingRow[];
  /** Rendered "now", handed down by the server so SSR and hydration agree. */
  nowIso: string;
}

export default function ListingsTable({ rows, nowIso }: Props) {
  const base = useMemo(() => prepareRows(rows), [rows]);

  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER);
  const [sort, setSort] = useState<SortState>(DEFAULT_SORT);
  const [cursor, setCursor] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [toast, setToast] = useState<(Toast & { id: number }) | null>(null);
  const [menu, setMenu] = useState<{ rowId: string; x: number; y: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const notify = useCallback((t: Toast) => {
    setToast({ ...t, id: Date.now() + Math.random() });
  }, []);

  // Confirmations fade on their own; errors stay until dismissed.
  useEffect(() => {
    if (!toast || toast.kind !== "ok") return;
    const id = setTimeout(() => setToast((t) => (t === toast ? null : t)), 2200);
    return () => clearTimeout(id);
  }, [toast]);

  const detail = useListingDetail(openId);
  const { patches, perform, saveNotes } = useRowActions({
    notify,
    openDetail: setOpenId,
    // A confirmed write changes the detail read model (timeline, notes row).
    onSettled: detail.invalidate,
  });

  // `now` comes from the server for the first paint, then follows the clock so
  // "2h" and "closing soon" don't go stale in a tab left open all afternoon.
  const [now, setNow] = useState(() => new Date(nowIso).getTime());
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  const patched = useMemo(() => applyPatches(base, patches), [base, patches]);

  // Typing stays responsive at ~2,900 rows because the expensive filter pass
  // runs against the deferred term, one render behind the input.
  const deferredSearch = useDeferredValue(filter.search);
  const effectiveFilter = useMemo(
    () => ({ ...filter, search: deferredSearch }),
    [filter, deferredSearch],
  );

  const visible = useMemo(
    () => sortRows(patched.filter(makeRowPredicate(effectiveFilter, now)), sort),
    [patched, effectiveFilter, sort, now],
  );

  const sources = useMemo(() => allSources(base), [base]);

  // Chip counts respect the disqualified/dismissed toggles so the numbers match
  // what clicking the chip would actually show.
  const counts = useMemo(() => {
    let disqualified = 0;
    let dismissed = 0;
    let saved = 0;
    let applied = 0;
    let closingSoon = 0;
    let highScore = 0;
    let fetchIssues = 0;
    for (const row of patched) {
      if (row.disqualified) disqualified += 1;
      if (row.dismissed) dismissed += 1;
      const hidden =
        (row.disqualified && !filter.showDisqualified) ||
        (row.dismissed && !filter.showDismissed);
      if (hidden) continue;
      if (row.saved) saved += 1;
      if (isTrackedApplied(row.statusKey)) applied += 1;
      if (isClosingSoon(row.deadlineTs, now)) closingSoon += 1;
      if ((row.score ?? -Infinity) >= HIGH_SCORE_THRESHOLD) highScore += 1;
      if (fetchBadge(row.fetchStatus)) fetchIssues += 1;
    }
    return { disqualified, dismissed, saved, applied, closingSoon, highScore, fetchIssues };
  }, [patched, filter.showDisqualified, filter.showDismissed, now]);

  // React Compiler skips any component using this hook (it returns functions it
  // can't safely memoize). That's accepted here: every expensive value in this
  // component is memoized by hand above, and the virtualizer is the one thing
  // that keeps ~2,900 rows to ~40 DOM nodes.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 14,
    getItemKey: useCallback((index: number) => visible[index]?.id ?? index, [visible]),
  });

  // The cursor is an index into the filtered view, so it has to be clamped when
  // the view shrinks under it (dismissing the focused row, tightening a filter).
  useEffect(() => {
    setCursor((c) => {
      if (c === null) return null;
      if (visible.length === 0) return null;
      return Math.min(c, visible.length - 1);
    });
  }, [visible.length]);

  // The detail panel follows the cursor while it is open (j/k, click).
  const openIdRef = useRef(openId);
  openIdRef.current = openId;
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  const focusCursor = useCallback(
    (index: number | null) => {
      setCursor(index);
      if (index === null) return;
      virtualizer.scrollToIndex(index, { align: "auto" });
      const row = visibleRef.current[index];
      if (row && openIdRef.current !== null) setOpenId(row.id);
    },
    [virtualizer],
  );

  const openRow = useMemo(
    () => (openId ? (patched.find((r) => r.id === openId) ?? null) : null),
    [openId, patched],
  );

  const menuRow = useMemo(
    () => (menu ? (patched.find((r) => r.id === menu.rowId) ?? null) : null),
    [menu, patched],
  );

  /** Every row action — key, menu item or panel button — goes through here. */
  const act = useCallback(
    (row: TableRow, command: RowCommand) => {
      void perform(row, command);
    },
    [perform],
  );

  const closeMenu = useCallback(() => {
    setMenu(null);
    // Hand focus back to the grid so j/k and the shortcuts keep working.
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  /** Right-click: move the cursor to the clicked row FIRST, then open. */
  const openMenuAt = useCallback(
    (index: number, x: number, y: number) => {
      const row = visibleRef.current[index];
      if (!row) return;
      focusCursor(index);
      setMenu({ rowId: row.id, x, y });
    },
    [focusCursor],
  );

  const onRowClick = useCallback(
    (index: number) => {
      const row = visibleRef.current[index];
      setCursor(index);
      if (row) setOpenId(row.id);
    },
    [],
  );

  // A single window-level listener, reading live state through a ref so it is
  // registered once rather than on every cursor move.
  const latest = useRef({ visible, cursor, showHelp, openId, menuOpen: false, focusCursor, act, openMenuAt });
  latest.current = {
    visible,
    cursor,
    showHelp,
    openId,
    menuOpen: menu !== null,
    focusCursor,
    act,
    openMenuAt,
  };

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // Never shadow a browser or OS shortcut, and never fire while typing.
      if (!isPlainKey(event)) return;
      if (isEditable(event.target)) return;

      const s = latest.current;
      // The open context menu owns the keyboard (it stops propagation too).
      if (s.menuOpen) return;
      const rowsNow = s.visible;
      const at = s.cursor;
      const row = at !== null ? rowsNow[at] : undefined;

      const move = (delta: number) => {
        if (rowsNow.length === 0) return;
        const next =
          at === null
            ? delta > 0
              ? 0
              : rowsNow.length - 1
            : Math.min(rowsNow.length - 1, Math.max(0, at + delta));
        s.focusCursor(next);
      };

      switch (event.key) {
        case "j":
        case "ArrowDown":
          event.preventDefault();
          move(1);
          return;
        case "k":
        case "ArrowUp":
          event.preventDefault();
          move(-1);
          return;
        case "g":
          event.preventDefault();
          if (rowsNow.length) s.focusCursor(0);
          return;
        case "G":
          event.preventDefault();
          if (rowsNow.length) s.focusCursor(rowsNow.length - 1);
          return;
        case "Enter":
          // Enter on a focused button or link (e.g. in the detail panel) is
          // that control's own activation, not "open the cursor row".
          if (!row || isActivatable(event.target)) return;
          event.preventDefault();
          s.act(row, { kind: "openDetail" });
          return;
        case "o":
          if (!row) return;
          event.preventDefault();
          s.act(row, { kind: "openUrl" });
          return;
        case "a":
          if (!row) return;
          event.preventDefault();
          s.act(row, { kind: "toggleApplied" });
          return;
        case "s":
          if (!row) return;
          event.preventDefault();
          s.act(row, { kind: "toggleSaved" });
          return;
        case "d":
          if (!row) return;
          event.preventDefault();
          s.act(row, { kind: "toggleDismissed" });
          return;
        case "ContextMenu":
        case "F10": {
          // The keyboard's menu key, or Shift+F10: open at the cursor row.
          if (event.key === "F10" && !event.shiftKey) return;
          if (!row || at === null) return;
          event.preventDefault();
          const el = document.querySelector<HTMLElement>(
            `[data-testid="listing-row"][aria-rowindex="${at + 1}"]`,
          );
          const rect = el?.getBoundingClientRect();
          s.openMenuAt(at, rect ? rect.left + 160 : 200, rect ? rect.bottom : 200);
          return;
        }
        case "/":
          event.preventDefault();
          searchRef.current?.focus();
          searchRef.current?.select();
          return;
        case "?":
          event.preventDefault();
          setShowHelp((v) => !v);
          return;
        case "Escape":
          if (s.showHelp) setShowHelp(false);
          else if (s.openId) setOpenId(null);
          else setCursor(null);
          return;
        default:
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Toolbar
        filter={filter}
        onChange={setFilter}
        searchRef={searchRef}
        onSearchEscape={() => {
          searchRef.current?.blur();
          setCursor(null);
        }}
        shown={visible.length}
        total={base.length}
        sources={sources}
        counts={counts}
        onShowHelp={() => setShowHelp(true)}
      />

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Header — same grid template as the rows, so nothing drifts. */}
          <div
            role="row"
            className="lt-grid shrink-0 border-b border-line bg-panel/80 py-1 font-mono text-[10px] tracking-wide text-faint uppercase"
          >
            {COLUMNS.map((col) => {
              const active = sort.key === col.key;
              return (
                <div
                  key={col.key}
                  role="columnheader"
                  aria-sort={
                    active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
                  }
                  className="lt-cell"
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, col.key))}
                    className={`flex w-full items-center gap-0.5 rounded-sm text-left uppercase hover:text-ink ${
                      col.align === "right" ? "justify-end" : ""
                    } ${active ? "text-ink" : ""}`}
                  >
                    {col.label}
                    <span className={active ? "text-accent" : "invisible"}>
                      {sort.dir === "asc" ? "▲" : "▼"}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>

          <div
            ref={scrollRef}
            tabIndex={-1}
            role="grid"
            aria-label="Ranked internship listings"
            aria-rowcount={visible.length}
            className="lt-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
          >
            {visible.length === 0 ? (
              <p className="px-3 py-8 text-center text-[12px] text-faint">
                Nothing matches these filters.
              </p>
            ) : (
              <div
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              >
                {items.map((item) => {
                  const row = visible[item.index];
                  if (!row) return null;
                  return (
                    <Row
                      key={item.key}
                      row={row}
                      index={item.index}
                      offset={item.start}
                      now={now}
                      focused={cursor === item.index}
                      open={openId === row.id}
                      onClick={onRowClick}
                      onContextMenu={openMenuAt}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {openRow && (
          <DetailPanel
            row={openRow}
            load={detail.load}
            now={now}
            onCommand={(command) => act(openRow, command)}
            onSaveNotes={saveNotes}
            onRetry={detail.retry}
            onClose={() => {
              setOpenId(null);
              scrollRef.current?.focus({ preventScroll: true });
            }}
          />
        )}
      </div>

      {menu && menuRow && (
        <ContextMenu
          key={`${menu.rowId}:${menu.x}:${menu.y}`}
          row={menuRow}
          point={{ x: menu.x, y: menu.y }}
          onClose={closeMenu}
          onCommand={(command) => {
            closeMenu();
            act(menuRow, command);
          }}
        />
      )}

      {toast && (
        <div
          key={toast.id}
          role={toast.kind === "error" ? "alert" : "status"}
          className={`fixed bottom-3 left-3 z-[60] flex max-w-md items-start gap-2 rounded border bg-panel px-3 py-2 text-[12px] shadow-lg ${
            toast.kind === "error" ? "border-bad/60 text-bad" : "border-ok/50 text-ok"
          }`}
        >
          <span className="min-w-0 flex-1">{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            className="shrink-0 text-faint hover:text-ink"
            aria-label="Dismiss message"
          >
            ×
          </button>
        </div>
      )}

      {showHelp && <HelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

const SCORE_TONE_CLASS = {
  high: "text-ok",
  mid: "text-ink",
  low: "text-dim",
  none: "text-faint",
} as const;

const STATUS_TONE_CLASS: Record<string, string> = {
  NOT_APPLIED: "text-faint",
  APPLIED: "text-accent",
  OA: "text-info",
  PHONE_SCREEN: "text-info",
  INTERVIEW: "text-info",
  OFFER: "text-ok",
  REJECTED: "text-bad",
  CLOSED: "text-faint",
  SKIPPED: "text-faint",
};

interface RowProps {
  row: TableRow;
  index: number;
  offset: number;
  now: number;
  focused: boolean;
  open: boolean;
  onClick: (index: number) => void;
  onContextMenu: (index: number, x: number, y: number) => void;
}

/**
 * One virtualized row. Memoized because a cursor move re-renders the list and
 * only two rows actually change.
 *
 * Every string here (company, title, location, disqualify reason) is scraped
 * third-party text and is rendered as a text child — no innerHTML anywhere.
 */
const Row = memo(function Row({
  row,
  index,
  offset,
  now,
  focused,
  open,
  onClick,
  onContextMenu,
}: RowProps) {
  const badge = fetchBadge(row.fetchStatus);
  const movement = rankMovement(row.rankDelta);
  const dq = row.disqualified ? dqBadge(row.disqualifyReasons) : null;
  const urgency = deadlineUrgency(row.deadlineTs, now);
  const muted = row.disqualified || row.dismissed;

  return (
    <div
      role="row"
      aria-rowindex={index + 1}
      aria-selected={focused}
      data-testid="listing-row"
      onClick={() => onClick(index)}
      // Only rows replace the browser's menu; everywhere else keeps it.
      onContextMenu={(e: ReactMouseEvent) => {
        e.preventDefault();
        onContextMenu(index, e.clientX, e.clientY);
      }}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: ROW_HEIGHT,
        transform: `translateY(${offset}px)`,
      }}
      className={`lt-grid cursor-default border-b border-line-soft/60 text-[12px] ${
        focused
          ? "bg-raised shadow-[inset_2px_0_0_var(--accent)]"
          : open
            ? "bg-raised/60"
            : "hover:bg-panel"
      } ${muted ? "opacity-55" : ""}`}
    >
      <span
        className="lt-cell flex items-baseline justify-end gap-[3px] font-mono tabular-nums"
        title={row.rank === null ? "no rank — disqualified" : movement?.label}
      >
        {movement && (
          <span
            data-testid="rank-move"
            className={`lt-rank-move ${movement.direction === "up" ? "text-ok" : "text-warn"}`}
          >
            {movement.text}
          </span>
        )}
        <span className="text-[10.5px] text-faint">{row.rank ?? "—"}</span>
      </span>

      <span
        className={`lt-cell text-right font-mono tabular-nums ${
          row.disqualified ? "text-faint line-through" : SCORE_TONE_CLASS[scoreTone(row.score)]
        }`}
        title={
          row.llmAdjustment !== null ? `includes LLM adjustment ${row.llmAdjustment}` : undefined
        }
      >
        {formatScore(row.score)}
      </span>

      <span className="lt-cell text-ink" title={row.company}>
        {row.faangPlus && (
          <span className="mr-1 text-warn" title="FAANG+ company">
            ★
          </span>
        )}
        {row.company}
      </span>

      <span className="lt-cell flex items-center gap-1.5" title={row.title}>
        <span className={`truncate ${row.likelyClosed ? "text-dim line-through" : "text-dim"}`}>
          {row.title}
        </span>
        {row.saved && (
          <Badge tone="accent" title="Saved">
            saved
          </Badge>
        )}
        {badge && (
          <Badge tone={badge.tone} title={badge.title} solid>
            {badge.label}
          </Badge>
        )}
        {row.likelyClosed && (
          <Badge tone="dim" title="No longer present in any source — probably closed">
            closed?
          </Badge>
        )}
        {row.dismissed && <Badge tone="dim">dismissed</Badge>}
        {dq && (
          <Badge tone="bad" title={dq.title}>
            {dq.text}
          </Badge>
        )}
      </span>

      <span
        className="lt-cell text-dim"
        // Name the other locations: "+1" on a multi-country posting hides
        // whether any of them are US, which decides eligibility.
        title={
          row.locationCount > 1
            ? row.allLocations.join(" · ") +
              (row.locationCount > row.allLocations.length ? " · …" : "")
            : row.location
        }
      >
        {row.location}
        {row.locationCount > 1 && (
          <span className="ml-1 text-faint">+{row.locationCount - 1}</span>
        )}
      </span>

      <span
        className="lt-cell text-right font-mono text-[11px] text-faint tabular-nums"
        title={`${row.postedAt ? "posted" : "first seen"} ${absoluteDate(row.ageTs)}`}
      >
        {relativeAge(row.ageTs, now)}
      </span>

      <span
        className={`lt-cell font-mono text-[11px] tabular-nums ${
          urgency === "soon" ? "font-semibold text-warn" : urgency === "past" ? "text-faint line-through" : "text-faint"
        }`}
        title={row.deadlineTs ? `deadline ${absoluteDay(row.deadlineTs)}` : undefined}
      >
        {formatDeadline(row.deadlineTs, now)}
      </span>

      <span className={`lt-cell ${STATUS_TONE_CLASS[row.statusKey] ?? "text-dim"}`}>
        {STATUS_LABELS[row.statusKey]}
      </span>

      <span className="lt-cell font-mono text-[10px] text-faint" title={row.sources.join(", ")}>
        {row.sources.join(" ")}
      </span>
    </div>
  );
});
