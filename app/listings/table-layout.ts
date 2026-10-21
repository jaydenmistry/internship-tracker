/**
 * The listings table's customizable layout: which columns show, in what
 * order and at what width, and which items the toolbar carries. Pure — the
 * table holds it in state and persists it in a cookie (LAYOUT_COOKIE), which
 * the page reads so the server renders the user's layout on the first byte.
 *
 * The cookie is user-controlled input, so `parseLayout` treats it as
 * untrusted: unknown ids are dropped, missing ones come back in their default
 * place, widths are clamped, and anything malformed falls back to defaults.
 */

import { z } from "zod";
import type { SortKey } from "./table-state";

export const LAYOUT_COOKIE = "listings-layout";

export type ColumnId = SortKey;

export interface ColumnDef {
  id: ColumnId;
  label: string;
  align?: "right";
  /** Default width in px. The fill column (role) treats it as a minimum. */
  width: number;
  min: number;
  /** Widest a resize can make it (default MAX_COLUMN_WIDTH). */
  max?: number;
  /** Shown in the phone-width layout too. */
  core?: true;
  /** Can't be hidden — the row needs something to be recognized by. */
  locked?: true;
}

/**
 * Default order. Role fills whatever space the fixed columns leave, until the
 * user resizes it — then it holds that width like any other column.
 */
export const COLUMN_DEFS: readonly ColumnDef[] = [
  { id: "rank", label: "#", align: "right", width: 48, min: 36, core: true },
  { id: "score", label: "score", align: "right", width: 52, min: 40, core: true },
  { id: "company", label: "company", width: 160, min: 72, core: true },
  { id: "role", label: "role", width: 160, min: 120, max: 1600, core: true, locked: true },
  { id: "location", label: "location", width: 144, min: 64 },
  { id: "age", label: "age", align: "right", width: 52, min: 40 },
  { id: "deadline", label: "deadline", width: 76, min: 56 },
  { id: "status", label: "status", width: 104, min: 64 },
  { id: "source", label: "source", width: 88, min: 56 },
];

export const FILL_COLUMN: ColumnId = "role";
export const MAX_COLUMN_WIDTH = 640;

const DEF = new Map(COLUMN_DEFS.map((c) => [c.id, c]));

export function columnDef(id: ColumnId): ColumnDef {
  return DEF.get(id)!;
}

/**
 * Everything the toolbar can show or hide. Search and the Filters button are
 * always there: every filter lives behind that button, so it can't be hidden.
 */
export const TOOLBAR_ITEMS = [
  { id: "count", label: "Result count", group: "Controls" },
  { id: "chip-saved", label: "Saved", group: "Quick filters" },
  { id: "chip-applied", label: "Applied", group: "Quick filters" },
  { id: "chip-closing", label: "Closing soon", group: "Quick filters" },
  { id: "chip-high", label: "High score", group: "Quick filters" },
  { id: "sort", label: "Sort", group: "Controls" },
  { id: "views", label: "Views", group: "Controls" },
  { id: "help", label: "Keyboard shortcuts", group: "Controls" },
] as const;

export type ToolbarItemId = (typeof TOOLBAR_ITEMS)[number]["id"];

export interface TableLayout {
  /** Every column, in display order — hidden ones keep their place. */
  order: ColumnId[];
  hidden: ColumnId[];
  /** Only columns the user resized; the rest use their default. */
  widths: Partial<Record<ColumnId, number>>;
  toolbarHidden: ToolbarItemId[];
}

export const DEFAULT_LAYOUT: TableLayout = {
  order: COLUMN_DEFS.map((c) => c.id),
  hidden: [],
  widths: {},
  toolbarHidden: [],
};

const COLUMN_IDS = new Set<string>(COLUMN_DEFS.map((c) => c.id));
const TOOLBAR_IDS = new Set<string>(TOOLBAR_ITEMS.map((t) => t.id));

const Stored = z.object({
  o: z.array(z.string()).max(32).optional(),
  h: z.array(z.string()).max(32).optional(),
  w: z.record(z.string(), z.number()).optional(),
  t: z.array(z.string()).max(64).optional(),
});

export function clampWidth(id: ColumnId, width: number): number {
  const def = columnDef(id);
  return Math.round(Math.min(def.max ?? MAX_COLUMN_WIDTH, Math.max(def.min, width)));
}

/** A cookie value (URI-encoded JSON) → a valid layout, never throwing. */
export function parseLayout(raw: string | undefined | null): TableLayout {
  if (!raw) return DEFAULT_LAYOUT;
  // Next.js hands cookies over already decoded; a raw header value isn't.
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    try {
      json = JSON.parse(decodeURIComponent(raw));
    } catch {
      return DEFAULT_LAYOUT;
    }
  }
  const parsed = Stored.safeParse(json);
  if (!parsed.success) return DEFAULT_LAYOUT;
  const { o = [], h = [], w = {}, t = [] } = parsed.data;

  const known = [...new Set(o.filter((id) => COLUMN_IDS.has(id)))] as ColumnId[];
  // A column added after the cookie was written slots in after the column
  // that precedes it by default, rather than at the end.
  const order = [...known];
  for (const def of COLUMN_DEFS) {
    if (order.includes(def.id)) continue;
    const at = COLUMN_DEFS.findIndex((c) => c.id === def.id);
    const before = COLUMN_DEFS.slice(0, at).map((c) => c.id).filter((id) => order.includes(id)).pop();
    order.splice(before ? order.indexOf(before) + 1 : 0, 0, def.id);
  }

  const widths: TableLayout["widths"] = {};
  for (const [id, value] of Object.entries(w)) {
    if (COLUMN_IDS.has(id) && Number.isFinite(value)) widths[id as ColumnId] = clampWidth(id as ColumnId, value);
  }

  return {
    order,
    hidden: [...new Set(h)].filter((id) => COLUMN_IDS.has(id) && !columnDef(id as ColumnId).locked) as ColumnId[],
    widths,
    toolbarHidden: [...new Set(t)].filter((id) => TOOLBAR_IDS.has(id)) as ToolbarItemId[],
  };
}

/** The cookie value: short keys, defaults left out, URI-encoded. */
export function serializeLayout(layout: TableLayout): string {
  const out: z.infer<typeof Stored> = {};
  if (layout.order.join() !== DEFAULT_LAYOUT.order.join()) out.o = layout.order;
  if (layout.hidden.length) out.h = layout.hidden;
  if (Object.keys(layout.widths).length) out.w = layout.widths;
  if (layout.toolbarHidden.length) out.t = layout.toolbarHidden;
  return encodeURIComponent(JSON.stringify(out));
}

export function columnWidth(layout: TableLayout, id: ColumnId): number {
  return layout.widths[id] ?? columnDef(id).width;
}

export function visibleColumns(layout: TableLayout): ColumnDef[] {
  return layout.order.filter((id) => !layout.hidden.includes(id)).map(columnDef);
}

/** The phone-width layout: the visible core columns, in the user's order. */
export function compactColumns(layout: TableLayout): ColumnDef[] {
  return visibleColumns(layout).filter((c) => c.core);
}

const COMPACT_WIDTH: Partial<Record<ColumnId, string>> = {
  rank: "2rem",
  score: "3rem",
  company: "minmax(5rem, 7rem)",
};

/** Whether the fill column still takes the leftover space (not resized). */
export function fills(layout: TableLayout, widths?: Partial<Record<ColumnId, number>>): boolean {
  return widths?.[FILL_COLUMN] === undefined && layout.widths[FILL_COLUMN] === undefined;
}

/** `grid-template-columns` for the full layout. */
export function gridTemplate(layout: TableLayout, widths?: Partial<Record<ColumnId, number>>): string {
  return visibleColumns(layout)
    .map((c) => {
      const w = widths?.[c.id] ?? columnWidth(layout, c.id);
      return c.id === FILL_COLUMN && fills(layout, widths) ? `minmax(${w}px, 1fr)` : `${w}px`;
    })
    .join(" ");
}

export function compactTemplate(layout: TableLayout): string {
  return compactColumns(layout)
    .map((c) => COMPACT_WIDTH[c.id] ?? "minmax(0, 1fr)")
    .join(" ");
}

/**
 * Narrowest the full grid can be, as CSS: every column at its width plus the
 * gaps and side padding (in rem, matching .lt-grid). Below it, the table
 * scrolls sideways rather than squeezing columns past what the user set.
 */
export function gridMinWidth(layout: TableLayout, widths?: Partial<Record<ColumnId, number>>): string {
  const cols = visibleColumns(layout);
  const sum = cols.reduce((n, c) => n + (widths?.[c.id] ?? columnWidth(layout, c.id)), 0);
  return `calc(${sum}px + ${Math.max(0, cols.length - 1)} * var(--lt-gap) + 2 * var(--lt-pad))`;
}

/** A column header's name in menus — "#" reads as "Rank" there. */
export function columnName(id: ColumnId): string {
  return id === "rank" ? "Rank" : columnDef(id).label.replace(/^./, (c) => c.toUpperCase());
}

export function toggleColumn(layout: TableLayout, id: ColumnId): TableLayout {
  if (columnDef(id).locked) return layout;
  const hidden = layout.hidden.includes(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id];
  return { ...layout, hidden };
}

export function toggleToolbarItem(layout: TableLayout, id: ToolbarItemId): TableLayout {
  const toolbarHidden = layout.toolbarHidden.includes(id)
    ? layout.toolbarHidden.filter((h) => h !== id)
    : [...layout.toolbarHidden, id];
  return { ...layout, toolbarHidden };
}

/**
 * Moves `id` to sit at `toIndex` among the VISIBLE columns (the only ones a
 * drag can see). Hidden columns keep their place relative to the column
 * they followed.
 */
export function moveColumn(layout: TableLayout, id: ColumnId, toIndex: number): TableLayout {
  const visible = layout.order.filter((c) => !layout.hidden.includes(c));
  const from = visible.indexOf(id);
  if (from === -1 || from === toIndex) return layout;
  const rest = visible.filter((c) => c !== id);
  const target = Math.max(0, Math.min(rest.length, toIndex));
  // Insert into the full order just before the visible column now at
  // `target`, or after the last visible one.
  const order = layout.order.filter((c) => c !== id);
  const anchor = rest[target];
  if (anchor) order.splice(order.indexOf(anchor), 0, id);
  else order.splice(order.indexOf(rest[rest.length - 1]) + 1, 0, id);
  return { ...layout, order };
}

export function resizeColumn(layout: TableLayout, id: ColumnId, width: number | null): TableLayout {
  const widths = { ...layout.widths };
  if (width === null) delete widths[id];
  else widths[id] = clampWidth(id, width);
  return { ...layout, widths };
}

/**
 * Where a dragged column lands. It passes a neighbour once its leading edge
 * crosses that neighbour's midpoint — half a column of travel, not a whole
 * one, so a swap answers the hand promptly. `rects` are the visible columns'
 * positions at drag start, in order.
 */
export function dropIndex(
  rects: ReadonlyArray<{ left: number; width: number }>,
  from: number,
  dx: number,
): number {
  const left = rects[from].left + dx;
  const right = left + rects[from].width;
  let index = 0;
  rects.forEach((r, i) => {
    const mid = r.left + r.width / 2;
    if ((i < from && left > mid) || (i > from && right > mid)) index += 1;
  });
  return index;
}

/**
 * How far each column shifts while one is dragged from `from` to `to`: the
 * ones it passes slide over by its width plus the gap, which is exactly where
 * they sit once the order is committed — so dropping never jumps.
 */
export function dragShifts(
  rects: ReadonlyArray<{ left: number; width: number }>,
  from: number,
  to: number,
  gap: number,
): number[] {
  const step = rects[from].width + gap;
  const shifts = rects.map((_, i) => {
    if (i === from) return 0;
    if (from < to && i > from && i <= to) return -step;
    if (to < from && i >= to && i < from) return step;
    return 0;
  });
  // The dragged column's resting place, relative to where it started.
  if (to > from) shifts[from] = rects[to].left + rects[to].width - rects[from].width - rects[from].left;
  else if (to < from) shifts[from] = rects[to].left - rects[from].left;
  return shifts;
}
