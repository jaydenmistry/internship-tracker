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
      className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-3 text-callout transition-colors ${
        active
          ? "border-accent/40 bg-accent/10 font-medium text-accent"
          : "border-line bg-canvas text-dim hover:bg-raised hover:text-ink"
      }`}
    >
      {children}
      {count !== undefined && (
        <span
          className={`text-subhead tabular-nums ${active ? "text-accent" : "text-faint"}`}
        >
          {count.toLocaleString("en-US")}
        </span>
      )}
    </button>
  );
}
