import type { ReactNode } from "react";

/**
 * Small inline marker for row flags (remote, closed, "couldn't fetch", …).
 * Presentational only — it renders `children` as text, never as markup.
 */

export type BadgeTone = "ink" | "dim" | "accent" | "ok" | "warn" | "bad" | "info";

const TONES: Record<BadgeTone, string> = {
  ink: "bg-raised text-dim",
  dim: "bg-raised/70 text-faint",
  accent: "bg-accent/12 text-accent",
  ok: "bg-ok/12 text-ok",
  warn: "bg-warn/14 text-warn",
  bad: "bg-bad/12 text-bad",
  info: "bg-info/12 text-info",
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
      className={`inline-flex shrink-0 items-center rounded-full px-1.5 text-footnote leading-4 font-semibold ${
        TONES[tone]
      } ${solid ? "ring-1 ring-current/20 ring-inset" : ""}`}
    >
      {children}
    </span>
  );
}
