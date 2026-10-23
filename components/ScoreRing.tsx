/**
 * The listing's score as a ring that fills to it, out of 100 — the inspector's
 * one signature element, because the score is what this app is for. The
 * number sits inside and is what a screen reader hears; the ring is
 * decorative. Only a high score takes a colour (ok), so the colour keeps one
 * meaning; a disqualified listing shows an empty ring and a struck number.
 */

import type { CSSProperties } from "react";
import CountUp from "./CountUp";

const ARC = {
  high: "stroke-ok",
  mid: "stroke-ink",
  low: "stroke-faint",
} as const;

interface Props {
  score: number | null;
  tone: "high" | "mid" | "low" | "none";
  struck?: boolean;
  size?: number;
}

export default function ScoreRing({ score, tone, struck = false, size = 76 }: Props) {
  const stroke = 6;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const pct = score === null || tone === "none" ? 0 : Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} title="Final score (0–100)">
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-line" />
        {tone !== "none" && (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            strokeWidth={stroke}
            strokeLinecap="round"
            // Drawn as an offset into a full-length dash, so it can animate
            // from empty (ring-draw) on every open.
            strokeDasharray={`${circumference} ${circumference}`}
            strokeDashoffset={circumference * (1 - pct)}
            style={{ "--ring-c": `${circumference}` } as CSSProperties}
            className={`ring-draw ${ARC[tone]}`}
          />
        )}
      </svg>
      <span
        className={`absolute inset-0 flex items-center justify-center text-headline font-semibold tracking-tight tabular-nums ${
          struck ? "text-faint line-through" : "text-ink"
        }`}
      >
        {/* Counts up while the ring draws, so the two arrive together. */}
        {score === null ? "—" : <CountUp value={Math.round(score)} duration={1100} />}
      </span>
    </div>
  );
}
