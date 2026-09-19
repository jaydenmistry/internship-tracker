"use client";

import type { ReactNode } from "react";

/**
 * A toggleable filter pill. Pressed state is carried by `aria-pressed` as well
 * as colour, so the active filters are legible to a screen reader too.
 */
interface Props {
  active: boolean;
  onClick: () => void;
  title?: string;
  /** Count shown after the label, e.g. the number of matching rows. */
  count?: number;
  children: ReactNode;
}

export default function Chip({ active, onClick, title, count, children }: Props) {
  return (
    <button
      type="button"
      aria-pressed={active}
      title={title}
      onClick={onClick}
      className={`inline-flex shrink-0 items-center gap-1 rounded border px-2 py-[3px] text-[12px] transition-colors ${
        active
          ? "border-accent bg-accent text-accent-ink"
          : "border-line bg-panel text-dim hover:border-faint hover:text-ink"
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`font-mono text-[10px] ${active ? "opacity-70" : "text-faint"}`}
        >
          {count.toLocaleString("en-US")}
        </span>
      )}
    </button>
  );
}
