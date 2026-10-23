/**
 * Celebrations: what each moment looks and sounds like.
 *
 * Call `celebrate()` synchronously from the click or key handler (it unlocks
 * audio, which browsers only allow inside a gesture), then
 * `celebrateProgress()` once the server says how many you've sent: the first
 * wave is instant, the bonus (first of the day, streak, milestone) lands a
 * beat later, which reads as the party escalating rather than lag.
 *
 * Reduced motion: no particles, no shake, no sweeps. The sound and the toast
 * still say it, so nothing is carried by motion alone.
 */

import type { ApplyProgress, Moment } from "@/lib/celebrate/moments";
import {
  cannons,
  confetti,
  fireworks,
  flash,
  floaters,
  GOLD,
  glyphs,
  lanterns,
  PALETTE,
  poof,
  pop,
  rain,
  ripples,
  shake,
  sweep,
  type Point,
} from "./engine";
import { boom, play, unlock, whistle } from "./sound";

export type Origin = Element | Point | null | undefined;

/** `[name="value"]`, quoted safely without relying on CSS.escape. */
export function attrSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function pointOf(origin: Origin): Point {
  if (origin && "getBoundingClientRect" in origin) {
    const r = origin.getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else if (origin && "x" in origin) {
    return origin;
  }
  return { x: window.innerWidth / 2, y: window.innerHeight * 0.66 };
}

/** The row or card around an origin, for the sweep. */
function hostOf(origin: Origin): Element | null {
  if (!origin || !("closest" in origin)) return null;
  return origin.closest('[role="row"], [data-testid="tracker-card"], [data-testid="tracker-row"]');
}

/** Tells the sidebar to bump a nav item (NavLinks listens). */
export const NAV_BUMP_EVENT = "celebrate:nav";

function bumpNav(href: string): void {
  window.dispatchEvent(new CustomEvent(NAV_BUMP_EVENT, { detail: href }));
}

const GREEN_WASH = "rgba(48, 209, 88, 0.28)";
const GOLD_WASH = "rgba(255, 214, 10, 0.32)";

export interface CelebrateOpts {
  origin?: Origin;
  /** Score 70+, saved or FAANG+: gold. */
  dream?: boolean;
}

export function celebrate(moment: Moment, opts: CelebrateOpts = {}): void {
  unlock();
  const reduce = prefersReducedMotion();
  const at = pointOf(opts.origin);
  const host = hostOf(opts.origin);
  const element = opts.origin && "getBoundingClientRect" in opts.origin ? opts.origin : null;

  switch (moment) {
    case "applied": {
      play(opts.dream ? "appliedBig" : "applied");
      bumpNav("/tracker");
      if (reduce) return;
      const colors = opts.dream ? GOLD : PALETTE;
      confetti(at, { count: opts.dream ? 120 : 90, colors, power: 13 });
      // A second, tighter pop a beat later makes it feel like it "lands".
      window.setTimeout(() => confetti(at, { count: 40, colors, power: 8, spread: Math.PI * 2, shapes: ["star", "circle"] }), 140);
      ripples(at, opts.dream ? "#FFD60A" : "#30D158", 2, 8);
      sweep(host, opts.dream ? GOLD_WASH : GREEN_WASH);
      pop(element);
      if (opts.dream) floaters(at, GOLD, 24, 160);
      return;
    }
    case "oa": {
      play("oa");
      if (reduce) return;
      glyphs(at, ["</>", "{ }", "λ", "01", "=>", "()", "[]", "✓", "#"], ["#0A84FF", "#64D2FF", "#BF5AF2", "#30D158"], 30);
      confetti(at, { count: 50, colors: ["#0A84FF", "#64D2FF", "#BF5AF2"], power: 10, shapes: ["rect", "circle"] });
      ripples(at, "#64D2FF", 2, 8);
      sweep(host, "rgba(100, 210, 255, 0.3)");
      pop(element, "rgba(100, 210, 255, 0.55)");
      return;
    }
    case "phone": {
      play("phone");
      if (reduce) return;
      // Rings like a phone ringing: two pulses of ripples.
      ripples(at, "#30D158", 3, 7);
      window.setTimeout(() => ripples(at, "#30D158", 3, 7), 420);
      glyphs(at, ["📞", "☎️", "💬", "✨"], ["#30D158"], 14);
      window.setTimeout(() => confetti(at, { count: 70, colors: ["#30D158", "#64D2FF", "#FFD60A", "#FFFFFF"], power: 12 }), 820);
      sweep(host, "rgba(48, 209, 88, 0.3)");
      pop(element);
      return;
    }
    case "interview": {
      play("interview");
      if (reduce) return;
      confetti(at, { count: 150, power: 15, shapes: ["star", "star", "rect", "ribbon", "circle"] });
      floaters(at, ["#FFD60A", "#FFFFFF", "#BF5AF2"], 36, 220);
      flash("#BF5AF2", 0.12, 26);
      rain(1200, ["#BF5AF2", "#FFD60A", "#64D2FF", "#FF6482", "#FFFFFF"]);
      sweep(host, "rgba(191, 90, 242, 0.3)");
      pop(element, "rgba(191, 90, 242, 0.55)");
      return;
    }
    case "offer": {
      play("offer");
      if (reduce) return;
      flash("#FFD60A", 0.22, 34);
      shake(6);
      cannons([...GOLD, ...PALETTE], 170);
      fireworks({
        count: 11,
        ms: 3600,
        onLaunch: () => whistle(0, 0.75),
        onBurst: () => boom(0, 0.9),
      });
      window.setTimeout(() => rain(2600, [...GOLD, "#FF375F", "#BF5AF2", "#64D2FF"]), 600);
      confetti(at, { count: 120, colors: GOLD, power: 16, shapes: ["star", "star", "circle"] });
      sweep(host, GOLD_WASH);
      pop(element, "rgba(255, 214, 10, 0.6)");
      return;
    }
    case "rejected": {
      // Gentle on purpose: a few warm lanterns float up. No shake, no red.
      play("rejected");
      if (reduce) return;
      lanterns(at, ["#64D2FF", "#BF5AF2", "#FFD60A", "#FF9F0A"]);
      ripples(at, "#64D2FF", 1, 0);
      return;
    }
  }
}

/** The second wave for an application: first of the day, streak, milestone. */
export function celebrateProgress(progress: ApplyProgress | undefined, opts: CelebrateOpts = {}): void {
  if (!progress) return;
  const reduce = prefersReducedMotion();
  const at = pointOf(opts.origin);

  if (progress.milestone) {
    play("milestone");
    if (reduce) return;
    flash("#FFD60A", 0.2, 30);
    shake(4);
    cannons([...PALETTE, ...GOLD], 160);
    window.setTimeout(() => rain(2200, [...PALETTE, ...GOLD]), 350);
    if (progress.milestone >= 50) {
      fireworks({ count: 6, ms: 2200, onLaunch: () => whistle(0, 0.7), onBurst: () => boom(0, 0.7) });
    }
    return;
  }

  const firstToday = progress.today === 1;
  const hot = progress.streak >= 2;
  if (!firstToday && !hot) return;
  play("bonus");
  if (reduce) return;
  if (firstToday) {
    // Sunrise: warm sparks lifting off.
    floaters(at, ["#FFD60A", "#FF9F0A", "#FFFFFF"], 30, 200);
    confetti(at, { count: 60, colors: ["#FFD60A", "#FF9F0A", "#FF6482"], power: 15 });
  }
  if (hot) {
    // Flames, more of them the longer the streak.
    glyphs(at, ["🔥"], ["#FF9F0A"], Math.min(4 + progress.streak * 2, 26));
  }
}

/** Saving a listing: a little gold star pop. */
export function celebrateSave(origin: Origin): void {
  unlock();
  play("save");
  if (prefersReducedMotion()) return;
  const at = pointOf(origin);
  confetti(at, { count: 16, colors: GOLD, power: 6, spread: Math.PI * 2, shapes: ["star"], size: 9, ttl: 70 });
  ripples(at, "#FFD60A", 1);
}

/** Dismissing a listing: a soft puff. */
export function celebrateDismiss(origin: Origin): void {
  unlock();
  play("dismiss");
  if (prefersReducedMotion()) return;
  poof(pointOf(origin));
}

/** A bulk import landed: one celebration for the batch, sized to it. */
export function celebrateImport(added: number): void {
  if (added <= 0) return;
  play(added >= 10 ? "milestone" : "appliedBig");
  bumpNav("/tracker");
  if (prefersReducedMotion()) return;
  cannons(PALETTE, Math.min(80 + added * 6, 200));
  if (added >= 10) window.setTimeout(() => rain(1800, PALETTE), 300);
}

/** An undo: a small reverse blip, no confetti. */
export function celebrateUndo(): void {
  unlock();
  play("undo");
}
