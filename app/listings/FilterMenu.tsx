"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/**
 * A toolbar button that opens a small panel underneath it — every filter,
 * the sort picker and the saved-views menu use it.
 *
 * While the panel is open it owns the keyboard: key presses inside it never
 * reach the table's window-level shortcuts (so typing "d" in a box or ticking
 * a checkbox can't dismiss the cursor row), and Escape closes the panel
 * instead of the detail panel.
 */
interface Props {
  label: string;
  /** Shown after the label when the filter is set, e.g. "simplify". */
  summary?: string | null;
  /** Highlights the button; defaults to "has a summary". */
  active?: boolean;
  align?: "left" | "right";
  /** Panel width class; panels size to content by default. */
  widthClass?: string;
  title?: string;
  children: (close: () => void) => ReactNode;
}

export default function FilterMenu({
  label,
  summary,
  active,
  align = "left",
  widthClass = "min-w-52",
  title,
  children,
}: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const buttonId = useId();
  const isActive = active ?? Boolean(summary);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // Looked up by id rather than through a ref: `close` is handed to the
  // panel during render, and a ref read there trips the React Compiler rules.
  const close = () => {
    setOpen(false);
    document.getElementById(buttonId)?.focus();
  };

  return (
    <div
      ref={rootRef}
      className="relative"
      onKeyDown={(event) => {
        if (!open) return;
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
    >
      <button
        id={buttonId}
        type="button"
        title={title}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((v) => !v)}
        className={`inline-flex h-7 max-w-64 items-center gap-1 rounded-full border px-3 text-callout transition-colors ${
          isActive
            ? "border-accent/40 bg-accent/10 text-ink"
            : "border-line bg-canvas text-dim hover:bg-raised hover:text-ink"
        }`}
      >
        <span className="shrink-0">{label}</span>
        {summary && <span className="min-w-0 truncate font-medium text-accent">: {summary}</span>}
        <ChevronDown aria-hidden size={13} className="-mr-1 shrink-0 text-faint" />
      </button>
      {open && (
        <div
          id={panelId}
          role="dialog"
          // Focusable, so a click on the panel's background keeps focus (and
          // the keyboard) inside the menu instead of dropping it on <body>,
          // where the table's single-key shortcuts would fire.
          tabIndex={-1}
          aria-label={label}
          className={`pop-in absolute top-full z-50 mt-1.5 ${widthClass} rounded-xl border border-line bg-panel/95 p-2 text-callout shadow-lg outline-none backdrop-blur-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

/** Small header row inside a panel: a hint on the left, "clear" on the right. */
export function PanelHeader({
  hint,
  onClear,
}: {
  hint: string;
  onClear?: (() => void) | null;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between gap-3 border-b border-line-soft pb-1.5 text-subhead text-faint">
      <span>{hint}</span>
      {onClear && (
        <button type="button" onClick={onClear} className="text-dim hover:text-ink">
          clear
        </button>
      )}
    </div>
  );
}

/** One radio choice in a single-select panel. */
export function RadioRow({
  name,
  checked,
  onSelect,
  children,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-dim hover:bg-raised hover:text-ink">
      <input
        type="radio"
        name={name}
        checked={checked}
        onChange={onSelect}
        className="accent-[var(--accent)]"
      />
      <span className={checked ? "text-ink" : ""}>{children}</span>
    </label>
  );
}

/** One checkbox in a panel, with an optional count on the right. */
export function CheckRow({
  checked,
  onChange,
  count,
  tone,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  count?: number;
  tone?: "warn";
  children: ReactNode;
}) {
  return (
    <label
      className={`flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 hover:bg-raised ${
        tone === "warn" ? "text-warn" : "text-dim hover:text-ink"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className={tone === "warn" ? "accent-[var(--warn)]" : "accent-[var(--accent)]"}
      />
      <span className={`flex-1 ${checked && tone !== "warn" ? "text-ink" : ""}`}>{children}</span>
      {count !== undefined && (
        <span className="font-mono text-footnote text-faint tabular-nums">
          {count.toLocaleString("en-US")}
        </span>
      )}
    </label>
  );
}
