import type { ReactNode } from "react";

/**
 * Small inline marker for row flags (remote, closed, "couldn't fetch", …).
 * Presentational only — it renders `children` as text, never as markup.
 */

export type BadgeTone = "ink" | "dim" | "accent" | "ok" | "warn" | "bad" | "info";

const TONES: Record<BadgeTone, string> = {
  ink: "border-line text-dim",
  dim: "border-line-soft text-faint",
  accent: "border-accent/40 text-accent",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/45 text-warn",
  bad: "border-bad/50 text-bad",
  info: "border-info/40 text-info",
};

interface Props {
  tone?: BadgeTone;
  /** Native tooltip. Used to spell out what a terse badge means. */
  title?: string;
  solid?: boolean;
  children: ReactNode;
}

export default function Badge({ tone = "ink", title, solid = false, children }: Props) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center rounded-sm border px-1 font-mono text-[10px] leading-[15px] tracking-tight ${
        TONES[tone]
      } ${solid ? "bg-raised" : ""}`}
    >
      {children}
    </span>
  );
}
