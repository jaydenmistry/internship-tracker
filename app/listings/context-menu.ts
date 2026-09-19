import type { AppStatus } from "@/generated/prisma/enums";
import type { RowCommand } from "./row-actions";
import { safeHttpUrl, STATUS_FILTER_LABELS, STATUS_ORDER, type TableRow } from "./table-state";

/**
 * The right-click menu's model: which items exist for a row, how the keyboard
 * moves through them, and where the menu goes on screen. Pure — the component
 * in ContextMenu.tsx only renders this and forwards keys.
 */

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export type MenuItemId =
  | "openUrl"
  | "copyUrl"
  | "status"
  | "save"
  | "dismiss"
  | "openDetail"
  | "copyLabel";

export interface MenuItem {
  id: MenuItemId;
  label: string;
  /** Keyboard shortcut that does the same thing from the table, if any. */
  hint?: string;
  disabled?: boolean;
  /** Opens the status submenu instead of acting. */
  submenu?: boolean;
  /** Draw a divider above this item. */
  separator?: boolean;
}

export type MenuRow = Pick<TableRow, "url" | "saved" | "dismissed" | "statusKey">;

export function buildMenuItems(row: MenuRow): MenuItem[] {
  const noUrl = safeHttpUrl(row.url) === null;
  return [
    { id: "openUrl", label: "Open apply link in new tab", hint: "o", disabled: noUrl },
    { id: "copyUrl", label: "Copy apply link", disabled: noUrl },
    { id: "status", label: "Set status", submenu: true, separator: true },
    { id: "save", label: row.saved ? "Unsave" : "Save", hint: "s" },
    { id: "dismiss", label: row.dismissed ? "Undismiss" : "Dismiss", hint: "d" },
    { id: "openDetail", label: "Open detail panel", hint: "↵", separator: true },
    { id: "copyLabel", label: "Copy “Company — Role”" },
  ];
}

export interface StatusItem {
  status: AppStatus;
  label: string;
  current: boolean;
}

export function buildStatusItems(current: AppStatus): StatusItem[] {
  return STATUS_ORDER.map((status) => ({
    status,
    label: STATUS_FILTER_LABELS[status],
    current: status === current,
  }));
}

/** What activating a top-level item does. Null for the submenu opener. */
export function commandForItem(id: MenuItemId): RowCommand | null {
  switch (id) {
    case "openUrl":
      return { kind: "openUrl" };
    case "copyUrl":
      return { kind: "copyUrl" };
    case "save":
      return { kind: "toggleSaved" };
    case "dismiss":
      return { kind: "toggleDismissed" };
    case "openDetail":
      return { kind: "openDetail" };
    case "copyLabel":
      return { kind: "copyLabel" };
    case "status":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation
// ---------------------------------------------------------------------------

export interface MenuNavState {
  /** Highlighted top-level item. */
  index: number;
  /** Highlighted submenu item, or null while the submenu is closed. */
  sub: number | null;
}

export interface MenuNavModel {
  items: ReadonlyArray<Pick<MenuItem, "disabled" | "submenu">>;
  subCount: number;
  /** Where the submenu's highlight starts (the current status). */
  subStart?: number;
}

export type MenuEffect =
  | { type: "none" }
  | { type: "close" }
  | { type: "activate"; index: number }
  | { type: "activateSub"; index: number };

export function initialMenuState(model: MenuNavModel): MenuNavState {
  return { index: firstEnabled(model.items), sub: null };
}

function firstEnabled(items: MenuNavModel["items"]): number {
  const i = items.findIndex((item) => !item.disabled);
  return i === -1 ? 0 : i;
}

/** Next enabled index in `step` direction, wrapping; stays put if none. */
function stepEnabled(items: MenuNavModel["items"], from: number, step: 1 | -1): number {
  const n = items.length;
  for (let k = 1; k <= n; k++) {
    const i = (((from + step * k) % n) + n) % n;
    if (!items[i]?.disabled) return i;
  }
  return from;
}

function wrap(i: number, n: number): number {
  return n === 0 ? 0 : ((i % n) + n) % n;
}

/**
 * One key press → the next state plus what to do. Arrows move (wrapping, and
 * skipping disabled items); → or Enter on "Set status" opens the submenu; ←
 * closes it; Enter/Space activates; Escape and Tab close the whole menu.
 */
export function menuKey(
  state: MenuNavState,
  key: string,
  model: MenuNavModel,
): { state: MenuNavState; effect: MenuEffect } {
  const none = (next: MenuNavState = state) => ({ state: next, effect: { type: "none" } as const });
  const item = model.items[state.index];
  const inSub = state.sub !== null;

  switch (key) {
    case "ArrowDown":
      return inSub
        ? none({ ...state, sub: wrap((state.sub ?? 0) + 1, model.subCount) })
        : none({ ...state, index: stepEnabled(model.items, state.index, 1) });
    case "ArrowUp":
      return inSub
        ? none({ ...state, sub: wrap((state.sub ?? 0) - 1, model.subCount) })
        : none({ ...state, index: stepEnabled(model.items, state.index, -1) });
    case "Home":
      return inSub
        ? none({ ...state, sub: 0 })
        : none({ ...state, index: firstEnabled(model.items) });
    case "End":
      return inSub
        ? none({ ...state, sub: Math.max(0, model.subCount - 1) })
        : none({ ...state, index: stepEnabled(model.items, 0, -1) });
    case "ArrowRight":
      if (!inSub && item?.submenu && !item.disabled) {
        return none({ ...state, sub: model.subStart ?? 0 });
      }
      return none();
    case "ArrowLeft":
      return inSub ? none({ ...state, sub: null }) : none();
    case "Enter":
    case " ":
      if (inSub) return { state, effect: { type: "activateSub", index: state.sub ?? 0 } };
      if (!item || item.disabled) return none();
      if (item.submenu) return none({ ...state, sub: model.subStart ?? 0 });
      return { state, effect: { type: "activate", index: state.index } };
    case "Escape":
    case "Tab":
      return { state, effect: { type: "close" } };
    default:
      return none();
  }
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));

/**
 * Opens at the pointer, flipping left/up when it would cross the right/bottom
 * edge, then clamps so it is never cut off (a menu taller than the viewport
 * pins to the top margin).
 */
export function clampMenuPosition(
  pointer: Point,
  menu: Size,
  viewport: Size,
  margin = 4,
): Point {
  let x = pointer.x;
  if (x + menu.width > viewport.width - margin) x = pointer.x - menu.width;
  let y = pointer.y;
  if (y + menu.height > viewport.height - margin) y = pointer.y - menu.height;
  return {
    x: clamp(x, margin, viewport.width - menu.width - margin),
    y: clamp(y, margin, viewport.height - menu.height - margin),
  };
}

/** Beside its parent item: to the right, or to the left when there is no room. */
export function placeSubmenu(
  anchor: { top: number; bottom: number; left: number; right: number },
  menu: Size,
  viewport: Size,
  margin = 4,
): Point {
  let x = anchor.right - 2;
  if (x + menu.width > viewport.width - margin) x = anchor.left - menu.width + 2;
  let y = anchor.top - 4;
  if (y + menu.height > viewport.height - margin) y = anchor.bottom - menu.height + 4;
  return {
    x: clamp(x, margin, viewport.width - menu.width - margin),
    y: clamp(y, margin, viewport.height - menu.height - margin),
  };
}
