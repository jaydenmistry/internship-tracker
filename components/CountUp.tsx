"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "./celebrate";

/**
 * A number that counts to its value: from zero when it first appears (for a
 * dashboard), and from the old value whenever it changes, with a little hop
 * when it goes up. A screen reader hears the final value, never the ticking;
 * with Reduce Motion it simply shows the value.
 */
interface Props {
  value: number;
  /** Count up from 0 on first render. Off for numbers that are always there (chip counts). */
  fromZero?: boolean;
  duration?: number;
  /** Appended to the number, e.g. "%". A string, not a formatter, so a
   *  server component can pass it. */
  suffix?: string;
  className?: string;
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

export default function CountUp({ value, fromZero = true, duration = 900, suffix = "", className }: Props) {
  const [shown, setShown] = useState(fromZero ? 0 : value);
  // What's on screen right now, so an interrupted count (or React running the
  // effect twice in development) resumes from there instead of jumping.
  const shownRef = useRef(fromZero ? 0 : value);
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const from = shownRef.current;
    if (from === value) return;
    let raf = 0;
    const reduce = prefersReducedMotion();
    const start = performance.now();
    const tick = (now: number) => {
      const t = reduce ? 1 : Math.min(1, (now - start) / duration);
      const n = Math.round(from + (value - from) * easeOut(t));
      shownRef.current = n;
      setShown(n);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // A rise, not the first count: hop so the change is noticed.
    if (!reduce && value > from && from !== 0 && spanRef.current?.animate) {
      spanRef.current.animate(
        [{ transform: "scale(1)" }, { transform: "scale(1.35)", offset: 0.35 }, { transform: "scale(1)" }],
        { duration: 500, easing: "cubic-bezier(0.34, 1.36, 0.64, 1)" },
      );
    }
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  const format = (n: number) => `${n.toLocaleString("en-US")}${suffix}`;
  // Only while it ticks is the moving number hidden from screen readers and
  // the final one spoken instead; at rest there's one plain number.
  const ticking = shown !== value;
  return (
    <span className={className}>
      <span ref={spanRef} aria-hidden={ticking || undefined} className="inline-block tabular-nums">
        {format(shown)}
      </span>
      {ticking && <span className="sr-only">{format(value)}</span>}
    </span>
  );
}
