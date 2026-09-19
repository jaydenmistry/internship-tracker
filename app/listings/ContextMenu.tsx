"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RowCommand } from "./row-actions";
import {
  buildMenuItems,
  buildStatusItems,
  clampMenuPosition,
  commandForItem,
  initialMenuState,
  menuKey,
  placeSubmenu,
  type MenuEffect,
  type MenuNavModel,
  type MenuNavState,
  type Point,
} from "./context-menu";
import type { TableRow } from "./table-state";

interface Props {
  row: TableRow;
  /** Pointer position in viewport coordinates. */
  point: Point;
  onCommand: (command: RowCommand) => void;
  /** Close without acting (Escape, Tab, click outside, scroll). */
  onClose: () => void;
}

/**
 * Right-click menu for one row. Focus sits on the top-level menu for its whole
 * life; the highlighted item (and submenu item) is announced through
 * `aria-activedescendant`, so arrow keys never have to chase DOM focus into a
 * submenu that mounts and unmounts.
 */
export default function ContextMenu({ row, point, onCommand, onClose }: Props) {
  const items = useMemo(() => buildMenuItems(row), [row]);
  const statusItems = useMemo(() => buildStatusItems(row.statusKey), [row.statusKey]);
  const model: MenuNavModel = useMemo(
    () => ({
      items,
      subCount: statusItems.length,
      subStart: Math.max(0, statusItems.findIndex((s) => s.current)),
    }),
    [items, statusItems],
  );

  const [nav, setNav] = useState<MenuNavState>(() => initialMenuState(model));
  const [pos, setPos] = useState<Point | null>(null);
  const [subPos, setSubPos] = useState<Point | null>(null);

  const menuRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const statusItemRef = useRef<HTMLDivElement>(null);

  // Measure, then place. Rendered hidden for this one frame so it never
  // flashes at an unclamped position.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    setPos(
      clampMenuPosition(
        point,
        { width: el.offsetWidth, height: el.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [point]);

  // Focus once placed: a `visibility: hidden` element can't take focus, so
  // focusing in the measuring pass above would silently fail.
  const placed = pos !== null;
  useLayoutEffect(() => {
    if (placed) menuRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useLayoutEffect(() => {
    if (nav.sub === null) return;
    const sub = subRef.current;
    const anchor = statusItemRef.current;
    if (!sub || !anchor) return;
    setSubPos(
      placeSubmenu(
        anchor.getBoundingClientRect(),
        { width: sub.offsetWidth, height: sub.offsetHeight },
        { width: window.innerWidth, height: window.innerHeight },
      ),
    );
  }, [nav.sub === null, pos]); // eslint-disable-line react-hooks/exhaustive-deps

  // Click outside, scroll, resize or leaving the window all close the menu.
  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || subRef.current?.contains(t)) return;
      closeRef.current();
    };
    const close = () => closeRef.current();
    const onScroll = (e: Event) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t) || subRef.current?.contains(t)) return;
      closeRef.current();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, []);

  function run(effect: MenuEffect) {
    if (effect.type === "close") {
      onClose();
      return;
    }
    if (effect.type === "activate") {
      const item = items[effect.index];
      const command = item && !item.disabled ? commandForItem(item.id) : null;
      if (command) onCommand(command);
      return;
    }
    if (effect.type === "activateSub") {
      const status = statusItems[effect.index]?.status;
      if (status) onCommand({ kind: "setStatus", status });
    }
  }

  function onKeyDown(event: React.KeyboardEvent) {
    // The table's single-key shortcuts must not see keys aimed at the menu.
    event.stopPropagation();
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const { state, effect } = menuKey(nav, event.key, model);
    if (event.key !== "Shift") event.preventDefault();
    setNav(state);
    run(effect);
  }

  const idBase = `ctx-${row.id}`;
  const activeId =
    nav.sub !== null ? `${idBase}-s${nav.sub}` : `${idBase}-i${nav.index}`;

  return (
    <>
      <div
        ref={menuRef}
        role="menu"
        aria-label="Row actions"
        tabIndex={-1}
        aria-activedescendant={activeId}
        onKeyDown={onKeyDown}
        onContextMenu={(e) => e.preventDefault()}
        className="ctx-menu fixed z-50 min-w-[14rem] rounded-md border border-line bg-panel py-1 text-[12px] shadow-2xl outline-none"
        style={{
          left: pos?.x ?? point.x,
          top: pos?.y ?? point.y,
          visibility: pos ? "visible" : "hidden",
        }}
      >
        {items.map((item, i) => {
          const active = nav.index === i;
          return (
            <div key={item.id}>
              {item.separator && <div role="separator" className="my-1 border-t border-line-soft" />}
              <div
                id={`${idBase}-i${i}`}
                ref={item.submenu ? statusItemRef : undefined}
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                aria-haspopup={item.submenu ? "menu" : undefined}
                aria-expanded={item.submenu ? nav.sub !== null : undefined}
                data-active={active || undefined}
                onPointerEnter={() => {
                  if (item.disabled) return;
                  setNav({
                    index: i,
                    sub: item.submenu ? (nav.sub ?? model.subStart ?? 0) : null,
                  });
                }}
                onClick={() => {
                  if (item.disabled) return;
                  if (item.submenu) {
                    setNav({ index: i, sub: nav.sub ?? model.subStart ?? 0 });
                    return;
                  }
                  run({ type: "activate", index: i });
                }}
                className={`ctx-item flex cursor-default items-center gap-3 px-3 py-[5px] ${
                  item.disabled ? "text-faint opacity-60" : "text-ink"
                }`}
              >
                <span className="flex-1 whitespace-nowrap">{item.label}</span>
                {item.hint && (
                  <kbd className="font-mono text-[10px] text-faint">{item.hint}</kbd>
                )}
                {item.submenu && <span className="text-faint">▸</span>}
              </div>
            </div>
          );
        })}
      </div>

      {nav.sub !== null && (
        <div
          ref={subRef}
          role="menu"
          aria-label="Set status"
          className="ctx-menu fixed z-50 min-w-[10rem] rounded-md border border-line bg-panel py-1 text-[12px] shadow-2xl"
          style={{
            left: subPos?.x ?? 0,
            top: subPos?.y ?? 0,
            visibility: subPos ? "visible" : "hidden",
          }}
        >
          {statusItems.map((s, i) => (
            <div
              key={s.status}
              id={`${idBase}-s${i}`}
              role="menuitemradio"
              aria-checked={s.current}
              data-active={nav.sub === i || undefined}
              onPointerEnter={() => setNav((n) => ({ ...n, sub: i }))}
              onClick={() => run({ type: "activateSub", index: i })}
              className="ctx-item flex cursor-default items-center gap-2 px-3 py-[5px] text-ink"
            >
              <span className="w-3 text-accent">{s.current ? "✓" : ""}</span>
              <span className="flex-1 whitespace-nowrap">{s.label}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
