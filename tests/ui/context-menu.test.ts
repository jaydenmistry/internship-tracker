import { describe, expect, it } from "vitest";
import {
  buildMenuItems,
  buildStatusItems,
  clampMenuPosition,
  commandForItem,
  initialMenuState,
  menuKey,
  placeSubmenu,
  type MenuNavModel,
  type MenuNavState,
} from "@/app/listings/context-menu";
import { STATUS_ORDER } from "@/app/listings/table-state";
import { rowFixture } from "./fixtures/listing-detail";

const row = rowFixture();
const items = buildMenuItems(row);
const STATUS_INDEX = items.findIndex((i) => i.id === "status");
const model: MenuNavModel = { items, subCount: STATUS_ORDER.length, subStart: 0 };

function press(state: MenuNavState, ...keys: string[]) {
  let s = state;
  let effect = { type: "none" } as ReturnType<typeof menuKey>["effect"];
  for (const k of keys) ({ state: s, effect } = menuKey(s, k, model));
  return { state: s, effect };
}

describe("menu items", () => {
  it("has every required action, in order", () => {
    expect(items.map((i) => i.id)).toEqual([
      "openUrl",
      "copyUrl",
      "status",
      "save",
      "dismiss",
      "openDetail",
      "copyLabel",
    ]);
  });

  it("labels Save/Dismiss by the row's current state", () => {
    const flipped = buildMenuItems(rowFixture({ saved: true, dismissed: true }));
    expect(flipped.find((i) => i.id === "save")?.label).toBe("Unsave");
    expect(flipped.find((i) => i.id === "dismiss")?.label).toBe("Undismiss");
    expect(items.find((i) => i.id === "save")?.label).toBe("Save");
  });

  it("disables the URL items when the link isn't http(s)", () => {
    const bad = buildMenuItems(rowFixture({ url: "javascript:alert(1)" }));
    expect(bad.find((i) => i.id === "openUrl")?.disabled).toBe(true);
    expect(bad.find((i) => i.id === "copyUrl")?.disabled).toBe(true);
  });

  it("lists every status in the submenu and marks the current one", () => {
    const subs = buildStatusItems("OA");
    expect(subs.map((s) => s.status)).toEqual(STATUS_ORDER);
    expect(subs.filter((s) => s.current).map((s) => s.status)).toEqual(["OA"]);
  });

  it("offers the split item only when something was merged in", () => {
    // The default row has nothing merged in: nothing to split.
    expect(items.some((i) => i.id === "splitMerge")).toBe(false);

    const merged = buildMenuItems(rowFixture({ mergedCount: 1 }));
    expect(merged.some((i) => i.id === "splitMerge")).toBe(true);

    // The count comes from the table read model, not from counting distinct
    // sources: two records from the SAME source merged together collapse to
    // one source id, and that row must still offer the split.
    const sameSource = buildMenuItems(rowFixture({ sources: ["simplify"], mergedCount: 1 }));
    expect(sameSource.some((i) => i.id === "splitMerge")).toBe(true);

    // Two sources with nothing merged in — a split that already happened, or
    // two rows the pipeline attached separately — offers nothing.
    expect(
      buildMenuItems(rowFixture({ sources: ["simplify", "intern-list"], mergedCount: 0 })).some(
        (i) => i.id === "splitMerge",
      ),
    ).toBe(false);

    // An exact count from the loaded detail panel overrides the row's own,
    // so a split shows its effect before the table has refetched.
    expect(buildMenuItems(row, 2).some((i) => i.id === "splitMerge")).toBe(true);
    expect(
      buildMenuItems(rowFixture({ mergedCount: 3 }), 0).some((i) => i.id === "splitMerge"),
    ).toBe(false);
  });

  it("sends the split item to the detail panel, where the entries are listed", () => {
    // A blind split from the menu would hide WHAT is being pulled apart.
    expect(commandForItem("splitMerge")).toEqual({ kind: "openDetail", focus: "merges" });
  });

  it("maps items to commands", () => {
    expect(commandForItem("save")).toEqual({ kind: "toggleSaved" });
    expect(commandForItem("dismiss")).toEqual({ kind: "toggleDismissed" });
    expect(commandForItem("copyLabel")).toEqual({ kind: "copyLabel" });
    expect(commandForItem("status")).toBeNull();
  });
});

describe("menu keyboard navigation", () => {
  const start = initialMenuState(model);

  it("starts on the first enabled item", () => {
    expect(start).toEqual({ index: 0, sub: null });
    const noUrl = buildMenuItems(rowFixture({ url: "ftp://x" }));
    expect(initialMenuState({ ...model, items: noUrl }).index).toBe(STATUS_INDEX);
  });

  it("moves with the arrows and wraps", () => {
    expect(press(start, "ArrowDown").state.index).toBe(1);
    expect(press(start, "ArrowUp").state.index).toBe(items.length - 1);
    expect(press(start, ...items.map(() => "ArrowDown")).state.index).toBe(0);
    expect(press(start, "End").state.index).toBe(items.length - 1);
    expect(press(press(start, "End").state, "Home").state.index).toBe(0);
  });

  it("skips disabled items", () => {
    const noUrl = buildMenuItems(rowFixture({ url: "ftp://x" }));
    const m = { ...model, items: noUrl };
    const s0 = initialMenuState(m);
    expect(menuKey(s0, "ArrowUp", m).state.index).toBe(noUrl.length - 1);
    const last = { index: noUrl.length - 1, sub: null };
    expect(menuKey(last, "ArrowDown", m).state.index).toBe(STATUS_INDEX);
  });

  it("→ opens the status submenu only on its item; ← closes it", () => {
    expect(press(start, "ArrowRight").state.sub).toBeNull();
    const onStatus = { index: STATUS_INDEX, sub: null };
    const opened = press(onStatus, "ArrowRight").state;
    expect(opened).toEqual({ index: STATUS_INDEX, sub: 0 });
    expect(press(opened, "ArrowLeft").state).toEqual(onStatus);
  });

  it("opens the submenu on the current status", () => {
    const m = { ...model, subStart: 4 };
    expect(menuKey({ index: STATUS_INDEX, sub: null }, "ArrowRight", m).state.sub).toBe(4);
  });

  it("arrows move within the open submenu and wrap", () => {
    const opened = { index: STATUS_INDEX, sub: 0 };
    expect(press(opened, "ArrowDown").state).toEqual({ index: STATUS_INDEX, sub: 1 });
    expect(press(opened, "ArrowUp").state.sub).toBe(STATUS_ORDER.length - 1);
  });

  it("Enter activates a plain item, opens the submenu, or picks a status", () => {
    expect(press(start, "Enter").effect).toEqual({ type: "activate", index: 0 });
    const onStatus = { index: STATUS_INDEX, sub: null };
    const r = press(onStatus, "Enter");
    expect(r.effect).toEqual({ type: "none" });
    expect(r.state.sub).toBe(0);
    expect(press(r.state, "ArrowDown", "ArrowDown", "Enter").effect).toEqual({
      type: "activateSub",
      index: 2,
    });
  });

  it("Enter on a disabled item does nothing", () => {
    const noUrl = buildMenuItems(rowFixture({ url: "ftp://x" }));
    expect(menuKey({ index: 0, sub: null }, "Enter", { ...model, items: noUrl }).effect).toEqual({
      type: "none",
    });
  });

  it("Escape and Tab close, from either level", () => {
    expect(press(start, "Escape").effect).toEqual({ type: "close" });
    expect(press({ index: STATUS_INDEX, sub: 3 }, "Escape").effect).toEqual({ type: "close" });
    expect(press(start, "Tab").effect).toEqual({ type: "close" });
  });

  it("ignores other keys (no stray table shortcuts)", () => {
    expect(press(start, "d")).toEqual({ state: start, effect: { type: "none" } });
  });
});

describe("viewport clamping", () => {
  const vp = { width: 1000, height: 800 };
  const menu = { width: 220, height: 240 };

  it("opens at the pointer when there is room", () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, menu, vp)).toEqual({ x: 100, y: 100 });
  });

  it("flips left near the right edge and up near the bottom", () => {
    expect(clampMenuPosition({ x: 900, y: 700 }, menu, vp)).toEqual({ x: 680, y: 460 });
  });

  it("never goes off the top-left, even for a menu bigger than the room", () => {
    expect(clampMenuPosition({ x: 100, y: 100 }, { width: 220, height: 780 }, vp)).toEqual({ x: 100, y: 4 });
    expect(clampMenuPosition({ x: 150, y: 150 }, { width: 300, height: 900 }, { width: 320, height: 800 })).toEqual({
      x: 4,
      y: 4,
    });
  });

  it("stays inside the margin exactly at the edge", () => {
    const p = clampMenuPosition({ x: 776, y: 556 }, menu, vp);
    expect(p.x + menu.width).toBeLessThanOrEqual(vp.width - 4);
    expect(p.y + menu.height).toBeLessThanOrEqual(vp.height - 4);
  });

  it("puts the submenu to the right of its item, or the left when there is no room", () => {
    const anchor = { top: 100, bottom: 124, left: 300, right: 520 };
    expect(placeSubmenu(anchor, { width: 160, height: 250 }, vp)).toEqual({ x: 518, y: 96 });
    const nearRight = { top: 100, bottom: 124, left: 700, right: 920 };
    expect(placeSubmenu(nearRight, { width: 160, height: 250 }, vp).x).toBe(542);
    const nearBottom = { top: 700, bottom: 724, left: 300, right: 520 };
    expect(placeSubmenu(nearBottom, { width: 160, height: 250 }, vp).y).toBe(478);
  });
});
