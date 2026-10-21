"use client";

import { Check } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { clampMenuPosition, type Point } from "./context-menu";

/**
 * A right-click menu of checkboxes — "which columns", "which toolbar items".
 * It stays open while you tick, so several can be changed in one visit, and
 * closes on Escape, Tab, a click outside, scrolling or resizing.
 *
 * Like the row menu, focus stays on the menu and the highlighted item is
 * announced through aria-activedescendant, so pointer and keyboard share one
 * highlight. Nothing is highlighted until you hover or press an arrow.
 */
export interface ChecklistItem {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
}

interface Props {
  label: string;
  point: Point;
  sections: ReadonlyArray<{ label?: string; items: readonly ChecklistItem[] }>;
  onToggle: (id: string) => void;
  /** Plain actions under the checkboxes, e.g. "Reset columns". */
  actions?: ReadonlyArray<{ label: string; onSelect: () => void; disabled?: boolean }>;
  onClose: () => void;
}

export default function ChecklistMenu({ label, point, sections, onToggle, actions = [], onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<Point | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const idBase = useId();

  // One flat list across sections and actions — what the arrows walk.
  const entries = [
    ...sections.flatMap((section) =>
      section.items.map((item) => ({ key: item.id, disabled: item.disabled, run: () => onToggle(item.id) })),
    ),
    ...actions.map((action) => ({
      key: `action:${action.label}`,
      disabled: action.disabled,
      run: () => {
        action.onSelect();
        onClose();
      },
    })),
  ];
  const enabled = entries.flatMap((e, i) => (e.disabled ? [] : [i]));

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

  const placed = pos !== null;
  useLayoutEffect(() => {
    if (placed) menuRef.current?.focus({ preventScroll: true });
  }, [placed]);

  const closeRef = useRef(onClose);
  useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const inside = (t: EventTarget | null) => menuRef.current?.contains(t as Node) ?? false;
    const onPointerDown = (e: PointerEvent) => {
      if (!inside(e.target)) closeRef.current();
    };
    const onScroll = (e: Event) => {
      if (!inside(e.target)) closeRef.current();
    };
    const close = () => closeRef.current();
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

  function onKeyDown(event: React.KeyboardEvent) {
    // The table's single-key shortcuts must not see keys aimed at the menu.
    event.stopPropagation();
    const at = active === null ? -1 : enabled.indexOf(active);
    const go = (i: number) => enabled.length && setActive(enabled[(i + enabled.length) % enabled.length]);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        go(at + 1);
        return;
      case "ArrowUp":
        event.preventDefault();
        go(at === -1 ? -1 : at - 1);
        return;
      case "Home":
        event.preventDefault();
        go(0);
        return;
      case "End":
        event.preventDefault();
        go(-1);
        return;
      case "Enter":
      case " ":
        event.preventDefault();
        if (active !== null && !entries[active]?.disabled) entries[active].run();
        return;
      case "Escape":
      case "Tab":
        event.preventDefault();
        onClose();
        return;
      default:
    }
  }

  const itemProps = (index: number, disabled: boolean | undefined) => ({
    id: `${idBase}-${index}`,
    "data-active": active === index || undefined,
    "aria-disabled": disabled || undefined,
    onPointerEnter: () => setActive(disabled ? null : index),
    onPointerLeave: () => setActive((a) => (a === index ? null : a)),
    onClick: () => !disabled && entries[index].run(),
  });

  let index = -1;
  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      aria-activedescendant={active === null ? undefined : `${idBase}-${active}`}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      className="ctx-menu pop-in fixed z-50 max-h-[calc(100vh-1rem)] min-w-[13rem] overflow-y-auto rounded-xl border border-line bg-panel/90 p-1 text-body shadow-lg outline-none backdrop-blur-xl"
      style={{ left: pos?.x ?? point.x, top: pos?.y ?? point.y, visibility: pos ? "visible" : "hidden" }}
    >
      {sections.map((section, s) => (
        <div key={section.label ?? s} role="group" aria-label={section.label}>
          {s > 0 && <div role="separator" className="my-1 border-t border-line-soft" />}
          {section.label && <p className="px-2.5 pt-1 pb-0.5 text-footnote font-semibold text-faint">{section.label}</p>}
          {section.items.map((item) => (
            <div
              key={item.id}
              role="menuitemcheckbox"
              aria-checked={item.checked}
              title={item.title}
              {...itemProps(++index, item.disabled)}
              className={`ctx-item flex cursor-default items-center gap-2 rounded-md px-2.5 py-1 ${
                item.disabled ? "text-faint" : "text-ink"
              }`}
            >
              <span className="flex w-3.5 shrink-0 justify-center">
                {item.checked && <Check aria-hidden size={13} strokeWidth={2.5} />}
              </span>
              <span className="flex-1 whitespace-nowrap">{item.label}</span>
            </div>
          ))}
        </div>
      ))}
      {actions.length > 0 && (
        <>
          <div role="separator" className="my-1 border-t border-line-soft" />
          {actions.map((action) => (
            <div
              key={action.label}
              role="menuitem"
              {...itemProps(++index, action.disabled)}
              className={`ctx-item flex cursor-default items-center gap-2 rounded-md px-2.5 py-1 ${
                action.disabled ? "text-faint opacity-60" : "text-ink"
              }`}
            >
              <span className="w-3.5 shrink-0" />
              <span className="flex-1 whitespace-nowrap">{action.label}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
