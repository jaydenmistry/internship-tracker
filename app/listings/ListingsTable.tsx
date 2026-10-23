"use client";

import {
  memo,
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Badge from "@/components/Badge";
import Toast from "@/components/Toast";
import { writePreference } from "@/components/preferences";
import type { ListingRow } from "@/lib/listings/query";
import type { SavedView } from "@/lib/listings/views";
import ChecklistMenu from "./ChecklistMenu";
import ContextMenu from "./ContextMenu";
import type { Point } from "./context-menu";
import DetailPanel from "./DetailPanel";
import { FILTERS_MENU_CLOSED, type FiltersMenuState } from "./FiltersMenu";
import HelpOverlay from "./HelpOverlay";
import { isActivatable, isEditable, isPlainKey } from "./keys";
import type { DetailFocus, RowCommand, Toast as ToastMessage } from "./row-actions";
import TableHeader from "./TableHeader";
import Toolbar from "./Toolbar";
import {
  columnName,
  compactTemplate,
  DEFAULT_LAYOUT,
  gridMinWidth,
  gridTemplate,
  LAYOUT_COOKIE,
  serializeLayout,
  toggleColumn,
  toggleToolbarItem,
  TOOLBAR_ITEMS,
  visibleColumns,
  type ColumnId,
  type TableLayout,
  type ToolbarItemId,
} from "./table-layout";
import {
  absoluteDate,
  absoluteDay,
  applyPatches,
  closedBadge,
  deadlineUrgency,
  fetchBadge,
  formatDeadline,
  formatScore,
  hiddenAsDisqualified,
  HIGH_SCORE_THRESHOLD,
  isClosingSoon,
  isTrackedApplied,
  prepareRows,
  rankMovement,
  relativeAge,
  rowDqBadge,
  scoreTone,
  sortRows,
  STATUS_LABELS,
  makeRowPredicate,
  type FilterState,
  type SortState,
  type TableRow,
  viewFromQuery,
  viewToQuery,
} from "./table-state";
import { useListingDetail } from "./useListingDetail";
import { useRowActions } from "./useRowActions";

/** Fixed row height — the virtualizer measures nothing, so cells never wrap. */
const ROW_HEIGHT = 36;

interface Props {
  rows: ListingRow[];
  /** Rendered "now", handed down by the server so SSR and hydration agree. */
  nowIso: string;
  /** Filters + sort to open with: the URL's query, or the default saved view's. */
  initialQuery: string;
  views: SavedView[];
  /** Column order, widths and visibility, and toolbar items — from the cookie. */
  initialLayout: TableLayout;
}

export default function ListingsTable({ rows, nowIso, initialQuery, views, initialLayout }: Props) {
  const base = useMemo(() => prepareRows(rows), [rows]);

  const [filter, setFilter] = useState<FilterState>(() => viewFromQuery(initialQuery).filter);
  const [sort, setSort] = useState<SortState>(() => viewFromQuery(initialQuery).sort);
  const [savedViews, setSavedViews] = useState<SavedView[]>(views);
  const [cursor, setCursor] = useState<number | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  /** Section the panel should reveal when a command opened it (split audit). */
  const [detailFocus, setDetailFocus] = useState<DetailFocus | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [filtersMenu, setFiltersMenu] = useState<FiltersMenuState>(FILTERS_MENU_CLOSED);
  const [toast, setToast] = useState<(ToastMessage & { id: number }) | null>(null);
  const [menu, setMenu] = useState<{ rowId: string; x: number; y: number } | null>(null);
  const [layout, setLayoutState] = useState<TableLayout>(initialLayout);
  const [layoutMenu, setLayoutMenu] = useState<{ kind: "columns" | "toolbar"; point: Point } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);

  const setLayout = useCallback((next: TableLayout) => {
    setLayoutState(next);
    writePreference(LAYOUT_COOKIE, serializeLayout(next));
  }, []);
  const columns = useMemo(() => visibleColumns(layout), [layout]);
  const columnIds = useMemo(() => columns.map((c) => c.id), [columns]);
  const toolbarHidden = useMemo(() => new Set(layout.toolbarHidden), [layout.toolbarHidden]);
  const wrapStyle = useMemo(
    () =>
      ({
        "--lt-cols": gridTemplate(layout),
        "--lt-cols-compact": compactTemplate(layout),
        "--lt-min": gridMinWidth(layout),
        // A row's content height (its bottom border excluded).
        "--lt-row": `${ROW_HEIGHT - 1}px`,
      }) as CSSProperties,
    [layout],
  );

  const notify = useCallback((t: ToastMessage) => {
    setToast({ ...t, id: Date.now() + Math.random() });
  }, []);

  const closeToast = useCallback(() => setToast(null), []);

  const detail = useListingDetail(openId);
  const openDetail = useCallback((listingId: string, focus?: DetailFocus) => {
    setOpenId(listingId);
    setDetailFocus(focus ?? null);
  }, []);
  const { patches, perform, saveNotes } = useRowActions({
    notify,
    openDetail,
    // A confirmed write changes the detail read model (timeline, notes row).
    onSettled: detail.invalidate,
    // A split changes BOTH listings' details; the table's own rows come back
    // with the Server Action's refresh(), which re-runs the page's query.
    onSplit: (parentId, newListingId) => {
      detail.invalidate(parentId);
      detail.invalidate(newListingId);
    },
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

  // The view lives in the URL so a reload or a bookmark keeps it. Written
  // with replaceState (no history entry per keystroke, no server round trip)
  // and debounced, since browsers throttle rapid history writes.
  const currentQuery = useMemo(() => viewToQuery({ filter, sort }), [filter, sort]);
  useEffect(() => {
    const id = setTimeout(() => {
      const next = currentQuery ? `?${currentQuery}` : window.location.pathname;
      if (window.location.search !== (currentQuery ? `?${currentQuery}` : "")) {
        window.history.replaceState(null, "", next);
      }
    }, 300);
    return () => clearTimeout(id);
  }, [currentQuery]);

  const applyView = useCallback((query: string) => {
    const view = viewFromQuery(query);
    setFilter(view.filter);
    setSort(view.sort);
  }, []);

  // A soft navigation to `/` (the nav's Listings link) re-renders the page
  // with a new initialQuery while this component stays mounted, so the
  // useState initializers above never see it. Adopt it here, during render,
  // so the table and the URL can't disagree.
  const [seenQuery, setSeenQuery] = useState(initialQuery);
  if (initialQuery !== seenQuery) {
    setSeenQuery(initialQuery);
    if (initialQuery !== currentQuery) {
      const view = viewFromQuery(initialQuery);
      setFilter(view.filter);
      setSort(view.sort);
    }
  }

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
      // Counts what the toggle reveals: roles you're in process for show anyway.
      if (hiddenAsDisqualified(row)) disqualified += 1;
      if (row.dismissed) dismissed += 1;
      const hidden =
        (hiddenAsDisqualified(row) && !filter.showDisqualified) ||
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
  // The listing the inspector shows: the open one, or — while it slides
  // closed — the last one that was open.
  const [panelRow, setPanelRow] = useState<TableRow | null>(null);
  if (openRow !== null && openRow !== panelRow) setPanelRow(openRow);

  const menuRow = useMemo(
    () => (menu ? (patched.find((r) => r.id === menu.rowId) ?? null) : null),
    [menu, patched],
  );

  // Exact merge count, but only for a row whose details are already loaded.
  // Null means "unknown" — the menu falls back to the row's source count.
  const menuMergeCount =
    menu && detail.load.status === "ready" && detail.load.detail.id === menu.rowId
      ? detail.load.detail.merges.length
      : null;

  /** Every row action — key, menu item or panel button — goes through here.
   *  Returns the promise so a panel button can show progress while it runs. */
  const act = useCallback(
    (row: TableRow, command: RowCommand) => perform(row, command),
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

  const shellRef = useRef<HTMLDivElement>(null);
  const closeDetail = useCallback(() => {
    setOpenId(null);
    scrollRef.current?.focus({ preventScroll: true });
  }, []);

  /**
   * Phone width: drag the sheet's grabber down to dismiss it. It follows the
   * finger, and closes once pulled a quarter of the way or flicked down;
   * otherwise it springs back.
   */
  function onSheetGrab(e: ReactPointerEvent<HTMLDivElement>) {
    const shell = shellRef.current;
    if (!shell) return;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    let lastY = startY;
    let lastT = e.timeStamp;
    let velocity = 0;
    shell.setAttribute("data-dragging", "");
    const move = (ev: PointerEvent) => {
      const dy = Math.max(0, ev.clientY - startY);
      velocity = (ev.clientY - lastY) / Math.max(1, ev.timeStamp - lastT);
      lastY = ev.clientY;
      lastT = ev.timeStamp;
      shell.style.setProperty("--dp-drag", `${dy}px`);
    };
    const up = (ev: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      shell.removeAttribute("data-dragging");
      const dy = Math.max(0, ev.clientY - startY);
      shell.style.removeProperty("--dp-drag");
      if (ev.type === "pointerup" && (dy > shell.offsetHeight / 4 || velocity > 0.6)) closeDetail();
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  const onRowClick = useCallback(
    (index: number) => {
      const row = visibleRef.current[index];
      setCursor(index);
      if (!row) return;
      // Clicking the open listing again closes the inspector.
      if (openIdRef.current === row.id) setOpenId(null);
      else openDetail(row.id);
    },
    [openDetail],
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
          // On a column heading or the toolbar, the menu key customizes them.
          if ((event.target as HTMLElement | null)?.closest?.("[role=columnheader], [data-toolbar]")) return;
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
        case "f":
          event.preventDefault();
          setFiltersMenu((m) => ({ ...m, open: true, pane: "list" }));
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
        sort={sort}
        onSortChange={setSort}
        rows={patched}
        now={now}
        searchRef={searchRef}
        onSearchEscape={() => {
          searchRef.current?.blur();
          setCursor(null);
        }}
        shown={visible.length}
        total={base.length}
        counts={counts}
        views={savedViews}
        currentQuery={currentQuery}
        onApplyView={applyView}
        onViewsChange={setSavedViews}
        onShowHelp={() => setShowHelp(true)}
        hidden={toolbarHidden}
        onCustomize={(point) => setLayoutMenu({ kind: "toolbar", point })}
        filtersMenu={filtersMenu}
        onFiltersMenu={setFiltersMenu}
      />

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <div ref={wrapRef} style={wrapStyle} className="lt-wrap flex min-w-0 flex-1 flex-col">
          {/* Header — same grid template as the rows, so nothing drifts. It
              sits outside the scroller and follows its sideways scroll. */}
          <TableHeader
            ref={headRef}
            layout={layout}
            columns={columns}
            sort={sort}
            onSort={setSort}
            onLayoutChange={setLayout}
            onColumnsMenu={(point) => setLayoutMenu({ kind: "columns", point })}
            wrapRef={wrapRef}
          />

          <div
            ref={scrollRef}
            tabIndex={-1}
            role="grid"
            aria-label="Ranked internship listings"
            aria-rowcount={visible.length}
            onScroll={(e) => {
              if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft;
            }}
            className="lt-scroll min-h-0 flex-1 overflow-auto"
          >
            {visible.length === 0 ? (
              <p className="px-3 py-12 text-center text-body text-faint">
                Nothing matches these filters.
              </p>
            ) : (
              <div
                className="lt-body"
                style={{ height: virtualizer.getTotalSize(), position: "relative" }}
              >
                {items.map((item) => {
                  const row = visible[item.index];
                  if (!row) return null;
                  return (
                    <Row
                      key={item.key}
                      row={row}
                      columns={columnIds}
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

        {/* The inspector overlays the table and slides in from the right —
            at phone width, up from the bottom as a sheet (globals.css).
            Closing keeps the last listing mounted (inert) so it can slide
            back out instead of vanishing. */}
        <div
          aria-hidden
          className="dp-scrim"
          data-open={openRow ? "" : undefined}
          onClick={closeDetail}
        />
        <div
          ref={shellRef}
          className="dp-shell absolute inset-y-0 right-0 z-20 flex w-[27rem] max-w-full"
          data-open={openRow ? "" : undefined}
          inert={!openRow}
        >
          <div aria-hidden className="dp-grab" onPointerDown={onSheetGrab} />
          {panelRow && (
            <DetailPanel
              key={panelRow.id}
              row={panelRow}
              load={detail.load}
              now={now}
              focus={detailFocus}
              onCommand={(command) => act(panelRow, command)}
              onSaveNotes={saveNotes}
              onRetry={detail.retry}
              onClose={closeDetail}
            />
          )}
        </div>
      </div>

      {menu && menuRow && (
        <ContextMenu
          key={`${menu.rowId}:${menu.x}:${menu.y}`}
          row={menuRow}
          point={{ x: menu.x, y: menu.y }}
          mergeCount={menuMergeCount}
          onClose={closeMenu}
          onCommand={(command) => {
            closeMenu();
            act(menuRow, command);
          }}
        />
      )}

      {/* Keyed so each toast restarts its entrance and its timer. */}
      {toast && <Toast key={toast.id} toast={toast} onClose={closeToast} />}

      {layoutMenu?.kind === "columns" && (
        <ChecklistMenu
          label="Columns"
          point={layoutMenu.point}
          sections={[
            {
              label: "Columns",
              items: layout.order.map((id) => ({
                id,
                label: columnName(id),
                checked: !layout.hidden.includes(id),
                disabled: id === "role",
                title: id === "role" ? "Always shown" : undefined,
              })),
            },
          ]}
          onToggle={(id) => setLayout(toggleColumn(layout, id as ColumnId))}
          actions={[
            {
              label: "Reset column widths",
              disabled: Object.keys(layout.widths).length === 0,
              onSelect: () => setLayout({ ...layout, widths: {} }),
            },
            {
              label: "Restore default columns",
              disabled:
                layout.hidden.length === 0 &&
                Object.keys(layout.widths).length === 0 &&
                layout.order.join() === DEFAULT_LAYOUT.order.join(),
              onSelect: () => setLayout({ ...DEFAULT_LAYOUT, toolbarHidden: layout.toolbarHidden }),
            },
          ]}
          onClose={() => setLayoutMenu(null)}
        />
      )}

      {layoutMenu?.kind === "toolbar" && (
        <ChecklistMenu
          label="Toolbar items"
          point={layoutMenu.point}
          sections={(["Quick filters", "Controls"] as const).map((group) => ({
            label: group,
            items: TOOLBAR_ITEMS.filter((t) => t.group === group).map((t) => ({
              id: t.id,
              label: t.label,
              checked: !toolbarHidden.has(t.id),
            })),
          }))}
          onToggle={(id) => setLayout(toggleToolbarItem(layout, id as ToolbarItemId))}
          actions={[
            {
              label: "Show everything",
              disabled: layout.toolbarHidden.length === 0,
              onSelect: () => setLayout({ ...layout, toolbarHidden: [] }),
            },
          ]}
          onClose={() => setLayoutMenu(null)}
        />
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
  APPLIED: "text-ink",
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
  /** Visible columns, in order. */
  columns: readonly ColumnId[];
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
  columns,
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
  const dq = rowDqBadge(row);
  const closed = closedBadge(row);
  const urgency = deadlineUrgency(row.deadlineTs, now);
  // A role you're in process for is never greyed or struck out for its score.
  const struck = hiddenAsDisqualified(row);
  const muted = struck || row.dismissed;

  // Every cell, keyed by column; the row renders the visible ones in the
  // user's order. `data-col` is what a column drag moves (TableHeader).
  const cells: Record<ColumnId, ReactNode> = {
    rank: (
      <span
        key="rank"
        data-col="rank"
        className="lt-cell flex items-baseline justify-end gap-[3px] tabular-nums"
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
        <span className="text-subhead text-faint">{row.rank ?? "—"}</span>
      </span>
    ),
    score: (
      <span
        key="score"
        data-col="score"
        className={`lt-cell text-right font-semibold tabular-nums ${
          row.disqualified
            ? `text-faint ${struck ? "line-through" : ""}`
            : SCORE_TONE_CLASS[scoreTone(row.score)]
        }`}
        title={
          row.llmAdjustment !== null ? `includes LLM adjustment ${row.llmAdjustment}` : undefined
        }
      >
        {formatScore(row.score)}
      </span>
    ),
    company: (
      <span key="company" data-col="company" className="lt-cell font-medium text-ink" title={row.company}>
        {row.faangPlus && (
          <span className="mr-1 text-warn" title="FAANG+ company">
            ★
          </span>
        )}
        {row.company}
      </span>
    ),
    role: (
      <span key="role" data-col="role" className="lt-cell flex items-center gap-1.5" title={row.title}>
        <span
          className={`truncate ${
            row.likelyClosed && !isTrackedApplied(row.statusKey) ? "text-dim line-through" : "text-ink"
          }`}
        >
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
        {closed && (
          <Badge tone="dim" title={closed.title}>
            {closed.text}
          </Badge>
        )}
        {row.dismissed && <Badge tone="dim">dismissed</Badge>}
        {dq && (
          <Badge tone={dq.tone} title={dq.title}>
            {dq.text}
          </Badge>
        )}
      </span>
    ),
    location: (
      <span
        key="location"
        data-col="location"
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
    ),
    age: (
      <span
        key="age"
        data-col="age"
        className="lt-cell text-right text-subhead text-faint tabular-nums"
        title={`${row.postedAt ? "posted" : "first seen"} ${absoluteDate(row.ageTs)}`}
      >
        {relativeAge(row.ageTs, now)}
      </span>
    ),
    deadline: (
      <span
        key="deadline"
        data-col="deadline"
        className={`lt-cell text-subhead tabular-nums ${
          urgency === "soon" ? "font-semibold text-warn" : urgency === "past" ? "text-faint line-through" : "text-faint"
        }`}
        title={row.deadlineTs ? `deadline ${absoluteDay(row.deadlineTs)}` : undefined}
      >
        {formatDeadline(row.deadlineTs, now)}
      </span>
    ),
    status: (
      <span key="status" data-col="status" data-celebrate={row.id} className="lt-cell text-subhead">
        {row.statusKey === "NOT_APPLIED" ? (
          <span className="text-faint">—</span>
        ) : (
          // The dot carries the colour, the word carries the meaning.
          <span className="inline-flex items-center gap-1.5 text-dim">
            <span aria-hidden className={`size-1.5 shrink-0 rounded-full bg-current ${STATUS_TONE_CLASS[row.statusKey] ?? ""}`} />
            {STATUS_LABELS[row.statusKey]}
          </span>
        )}
      </span>
    ),
    source: (
      <span key="source" data-col="source" className="lt-cell text-subhead text-faint" title={row.sources.join(", ")}>
        {row.sources.join(" ")}
      </span>
    ),
  };

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
      className={`lt-grid cursor-default border-b border-line-soft text-callout transition-colors duration-150 ${
        focused
          ? "bg-accent/10 shadow-[inset_3px_0_0_var(--accent)]"
          : open
            ? "bg-raised"
            : "hover:bg-raised/50"
      } ${muted ? "opacity-55" : ""}`}
    >
      {columns.map((id) => cells[id])}
    </div>
  );
});
