"use client";

import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type Ref, type RefObject } from "react";
import type { Point } from "./context-menu";
import {
  clampWidth,
  dragShifts,
  dropIndex,
  FILL_COLUMN,
  gridMinWidth,
  gridTemplate,
  moveColumn,
  resizeColumn,
  type ColumnDef,
  type ColumnId,
  type TableLayout,
} from "./table-layout";
import { nextSort, type SortKey, type SortState } from "./table-state";

/**
 * The listings table's header row. Click a heading to sort; drag it sideways
 * to move the column; drag the line after a heading to resize that column
 * (double-click it to reset — for role, to fill the leftover width again);
 * right-click for the column picker.
 *
 * Both drags run outside React until the pointer is released, so a move costs
 * a style write rather than re-rendering ~40 virtualized rows per frame:
 *   - moving writes per-column transforms into one <style> element, keyed by
 *     `data-col`, which reaches header and body cells alike — including rows
 *     the virtualizer mounts mid-drag. The columns it passes slide to exactly
 *     where the committed order puts them, so the drop never jumps.
 *   - resizing rewrites the wrapper's --lt-cols / --lt-min variables.
 * Neither exists at phone width, where the table shows its core columns only.
 */

/** Below this the table is in its phone layout (globals.css, @container lt). */
const COMPACT_MAX = 640;
const DRAG_THRESHOLD = 4;
const SETTLE_MS = 180;

interface Props {
  ref: Ref<HTMLDivElement>;
  layout: TableLayout;
  columns: readonly ColumnDef[];
  sort: SortState;
  onSort: (next: SortState) => void;
  onLayoutChange: (next: TableLayout) => void;
  onColumnsMenu: (point: Point) => void;
  /** The `.lt-wrap` element whose variables size the grid. */
  wrapRef: RefObject<HTMLDivElement | null>;
}

interface Drag {
  id: ColumnId;
  pointerId: number;
  startX: number;
  from: number;
  rects: Array<{ left: number; width: number }>;
  gap: number;
  started: boolean;
  to: number;
}

export default function TableHeader({ ref, layout, columns, sort, onSort, onLayoutChange, onColumnsMenu, wrapRef }: Props) {
  const styleRef = useRef<HTMLStyleElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  /** A drag just ended on this heading — swallow the click it produces. */
  const suppressClick = useRef(false);
  /** The committed order is about to render — clear the drag transforms then. */
  const clearOnCommit = useRef(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useLayoutEffect(() => {
    if (!clearOnCommit.current) return;
    clearOnCommit.current = false;
    if (styleRef.current) styleRef.current.textContent = "";
    rowRef.current?.removeAttribute("data-dragging");
  }, [layout]);

  const compact = () => (wrapRef.current?.clientWidth ?? Infinity) < COMPACT_MAX;

  function writeShifts(d: Drag, dx: number, settling: boolean) {
    const shifts = dragShifts(d.rects, d.from, d.to, d.gap);
    const ease = "transform 200ms var(--ease-out)";
    const css = columns
      .map((c, i) => {
        const sel = `.lt-wrap [data-col="${c.id}"]`;
        if (i !== d.from) return `${sel}{transform:translateX(${shifts[i]}px);transition:${ease}}`;
        const x = settling ? shifts[i] : dx;
        const move = `transform:translateX(${x}px);transition:${settling ? `transform ${SETTLE_MS}ms var(--ease-out)` : "none"}`;
        // Lifted: a full-height strip in the raised colour, its sides covering
        // half the gap each way and edged with a hairline.
        const lift =
          "z-index:2;align-self:stretch;line-height:var(--lt-row);background:var(--raised);" +
          "box-shadow:calc(var(--lt-gap)/-2) 0 0 var(--raised),calc(var(--lt-gap)/2) 0 0 var(--raised)," +
          "calc(var(--lt-gap)/-2 - 1px) 0 0 var(--line),calc(var(--lt-gap)/2 + 1px) 0 0 var(--line)";
        return `${sel}{${move};${lift}}.lt-head [data-col="${c.id}"]{margin-block:-0.625rem;padding-block:0.625rem;line-height:inherit}`;
      })
      .join("");
    if (styleRef.current) styleRef.current.textContent = css;
  }

  function onHeadPointerDown(e: ReactPointerEvent<HTMLDivElement>, index: number, id: ColumnId) {
    if (e.button !== 0 || compact() || drag.current) return;
    const cells = [...(rowRef.current?.querySelectorAll<HTMLElement>("[role=columnheader]") ?? [])];
    const rects = cells.map((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    const gap = rects.length > 1 ? rects[1].left - rects[0].left - rects[0].width : 0;
    const d: Drag = { id, pointerId: e.pointerId, startX: e.clientX, from: index, rects, gap, started: false, to: index };
    drag.current = d;

    // Window listeners rather than pointer capture: capturing would retarget
    // the click that follows, and a plain click on the heading must sort.
    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      // Kept inside the row: a column can't be dragged off either end.
      const first = d.rects[0];
      const last = d.rects[d.rects.length - 1];
      const dragged = d.rects[d.from];
      const dx = Math.min(
        last.left + last.width - dragged.width - dragged.left,
        Math.max(first.left - dragged.left, ev.clientX - d.startX),
      );
      if (!d.started) {
        if (Math.abs(ev.clientX - d.startX) < DRAG_THRESHOLD) return;
        d.started = true;
        rowRef.current?.setAttribute("data-dragging", d.id);
        document.documentElement.setAttribute("data-col-drag", "");
      }
      ev.preventDefault();
      d.to = dropIndex(d.rects, d.from, dx);
      writeShifts(d, dx, false);
    };
    const end = (ev: PointerEvent) => {
      if (ev.pointerId !== d.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      drag.current = null;
      if (!d.started) return;
      document.documentElement.removeAttribute("data-col-drag");
      // The click this pointerup produces (if any) is the drag's, not a sort.
      suppressClick.current = true;
      setTimeout(() => {
        suppressClick.current = false;
      }, 0);
      if (ev.type === "pointercancel") d.to = d.from;
      // Glide into the slot, then commit the order underneath it.
      writeShifts(d, 0, true);
      clearTimeout(settleTimer.current);
      settleTimer.current = setTimeout(() => {
        if (d.to === d.from) {
          if (styleRef.current) styleRef.current.textContent = "";
          rowRef.current?.removeAttribute("data-dragging");
          return;
        }
        clearOnCommit.current = true;
        onLayoutChange(moveColumn(layout, d.id, d.to));
      }, SETTLE_MS);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  }

  function onResizeStart(e: ReactPointerEvent<HTMLDivElement>, id: ColumnId) {
    e.stopPropagation();
    if (e.button !== 0 || compact()) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    handle.setAttribute("data-active", "");
    const startX = e.clientX;
    // Measured, not read from the layout: the fill column (role) is usually
    // wider than its stored minimum, and the drag must start where it is.
    const startW = clampWidth(id, handle.parentElement?.getBoundingClientRect().width ?? 0);
    let width = startW;
    const wrap = wrapRef.current;
    document.documentElement.setAttribute("data-col-resize", "");

    const move = (ev: PointerEvent) => {
      width = clampWidth(id, startW + ev.clientX - startX);
      wrap?.style.setProperty("--lt-cols", gridTemplate(layout, { [id]: width }));
      wrap?.style.setProperty("--lt-min", gridMinWidth(layout, { [id]: width }));
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.removeAttribute("data-active");
      document.documentElement.removeAttribute("data-col-resize");
      if (width !== startW) onLayoutChange(resizeColumn(layout, id, width));
      else {
        // Back where it started: nothing to commit, so React won't rewrite
        // the variables — put back the layout's own (role may still fill).
        wrap?.style.setProperty("--lt-cols", gridTemplate(layout));
        wrap?.style.setProperty("--lt-min", gridMinWidth(layout));
      }
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  }

  return (
    <div ref={ref} className="shrink-0 overflow-hidden border-b border-line bg-canvas">
      <style ref={styleRef} />
      <div
        ref={rowRef}
        role="row"
        className="lt-grid lt-head th group/head py-2.5 select-none"
        onContextMenu={(e) => {
          e.preventDefault();
          // The keyboard's menu key reports (0, 0): open under the heading.
          if (e.clientX === 0 && e.clientY === 0) {
            const r = (e.target as HTMLElement).getBoundingClientRect();
            onColumnsMenu({ x: r.left, y: r.bottom + 4 });
          } else onColumnsMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {columns.map((col, index) => {
          const active = sort.key === col.id;
          return (
            <div
              key={col.id}
              role="columnheader"
              data-col={col.id}
              aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
              onPointerDown={(e) => onHeadPointerDown(e, index, col.id)}
              className="lt-th relative min-w-0"
            >
              <button
                type="button"
                title="Sort · drag to move · right-click to choose columns"
                onClick={() => {
                  if (suppressClick.current) return;
                  onSort(nextSort(sort, col.id as SortKey));
                }}
                className={`flex w-full items-center gap-0.5 rounded-sm text-left capitalize hover:text-ink ${
                  col.align === "right" ? "justify-end" : ""
                } ${active ? "text-ink" : ""}`}
              >
                <span className="truncate">{col.label}</span>
                <span className={active ? "text-accent" : "invisible"}>{sort.dir === "asc" ? "▲" : "▼"}</span>
              </button>
              <div
                aria-hidden
                title={
                  col.id === FILL_COLUMN
                    ? "Drag to resize · double-click to fill the width again"
                    : "Drag to resize · double-click to reset"
                }
                className="lt-resize"
                onPointerDown={(e) => onResizeStart(e, col.id)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => {
                  e.stopPropagation();
                  onLayoutChange(resizeColumn(layout, col.id, null));
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
