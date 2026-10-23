/**
 * The particle engine behind every celebration: one full-screen canvas laid
 * over the page (pointer-events: none, so it never blocks a click), one
 * requestAnimationFrame loop that runs only while something is on screen.
 *
 * It lives outside React on purpose. The listings table virtualizes its rows,
 * so a burst drawn inside a row would be cut off the moment it scrolled or
 * re-rendered; out here an effect outlives whatever started it.
 *
 * Callers check reduced motion (see ./index.ts); this module just draws.
 */

export interface Point {
  x: number;
  y: number;
}

type Shape = "rect" | "ribbon" | "circle" | "star" | "spark" | "glyph" | "orb";

interface Particle {
  x: number;
  y: number;
  /** px per frame at 60fps */
  vx: number;
  vy: number;
  gravity: number;
  /** Velocity kept per frame, 0–1. */
  drag: number;
  size: number;
  color: string;
  shape: Shape;
  glyph?: string;
  rot: number;
  vr: number;
  /** Confetti "flip": scales one axis by cos(flip) so pieces tumble in 3D. */
  flip: number;
  vflip: number;
  /** Side-to-side sway, for things that float. */
  sway: number;
  life: number;
  ttl: number;
  twinkle: boolean;
}

interface Ring {
  x: number;
  y: number;
  r: number;
  vr: number;
  width: number;
  color: string;
  life: number;
  ttl: number;
  delay: number;
}

interface Rocket {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
  color: string;
  burst: (at: Point) => void;
}

interface Glow {
  color: string;
  life: number;
  ttl: number;
  strength: number;
}

export const PALETTE = ["#0A84FF", "#30D158", "#FFD60A", "#FF9F0A", "#FF375F", "#BF5AF2", "#64D2FF", "#FF6482"];
export const GOLD = ["#FFD60A", "#FFC300", "#FFE680", "#F5B400", "#FFF4C2", "#FFB340"];

const MAX_PARTICLES = 2400;

let canvas: HTMLCanvasElement | null = null;
let ctx2d: CanvasRenderingContext2D | null = null;
let dpr = 1;
let raf = 0;
let last = 0;
const particles: Particle[] = [];
const rings: Ring[] = [];
const rockets: Rocket[] = [];
const glows: Glow[] = [];
const timers = new Set<number>();

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pickOf = <T,>(xs: readonly T[]) => xs[Math.floor(Math.random() * xs.length)];

function isLight(): boolean {
  return document.documentElement.dataset.theme === "light";
}

function ensureCanvas(): CanvasRenderingContext2D | null {
  if (typeof document === "undefined") return null;
  if (canvas && ctx2d && canvas.isConnected) return ctx2d;
  canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.dataset.celebrate = "canvas";
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100vw",
    height: "100vh",
    pointerEvents: "none",
    zIndex: "9999",
  });
  document.body.appendChild(canvas);
  ctx2d = canvas.getContext("2d");
  resize();
  window.addEventListener("resize", resize);
  return ctx2d;
}

function resize(): void {
  if (!canvas) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

function start(): void {
  if (!ensureCanvas()) return;
  if (raf) return;
  last = performance.now();
  raf = requestAnimationFrame(frame);
}

function add(p: Partial<Particle> & Pick<Particle, "x" | "y" | "vx" | "vy">): void {
  if (particles.length >= MAX_PARTICLES) particles.shift();
  particles.push({
    gravity: 0.18,
    drag: 0.985,
    size: 8,
    color: pickOf(PALETTE),
    shape: "rect",
    rot: rand(0, Math.PI * 2),
    vr: rand(-0.2, 0.2),
    flip: rand(0, Math.PI * 2),
    vflip: rand(0.08, 0.25),
    sway: 0,
    life: 0,
    ttl: 140,
    twinkle: false,
    ...p,
  });
}

/** Schedules work on the effect clock; cleared if everything is cancelled. */
function later(ms: number, fn: () => void): void {
  const id = window.setTimeout(() => {
    timers.delete(id);
    fn();
  }, ms);
  timers.add(id);
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

export interface ConfettiOpts {
  count?: number;
  colors?: readonly string[];
  /** Launch speed, px/frame. */
  power?: number;
  /** Direction in radians; -π/2 is straight up. */
  angle?: number;
  /** Cone width in radians. */
  spread?: number;
  shapes?: readonly Shape[];
  size?: number;
  ttl?: number;
}

/** A burst of tumbling confetti from one point. */
export function confetti(at: Point, o: ConfettiOpts = {}): void {
  const count = o.count ?? 60;
  const angle = o.angle ?? -Math.PI / 2;
  const spread = o.spread ?? Math.PI * 1.1;
  const power = o.power ?? 11;
  const shapes = o.shapes ?? ["rect", "rect", "ribbon", "circle", "star"];
  for (let i = 0; i < count; i += 1) {
    const a = angle + rand(-spread / 2, spread / 2);
    const v = power * rand(0.45, 1.1);
    const shape = pickOf(shapes);
    add({
      x: at.x,
      y: at.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      color: pickOf(o.colors ?? PALETTE),
      shape,
      size: (o.size ?? 8) * rand(0.7, 1.3) * (shape === "star" ? 1.3 : 1),
      gravity: rand(0.16, 0.24),
      drag: rand(0.955, 0.975),
      ttl: (o.ttl ?? 150) * rand(0.8, 1.2),
    });
  }
  start();
}

/** Two confetti cannons firing in from the bottom corners. */
export function cannons(colors: readonly string[] = PALETTE, count = 150): void {
  const h = window.innerHeight;
  const w = window.innerWidth;
  const power = Math.max(22, Math.min(34, h / 26));
  confetti({ x: -10, y: h + 10 }, { count, colors, power, angle: -Math.PI / 3, spread: 0.6, size: 10, ttl: 240 });
  confetti({ x: w + 10, y: h + 10 }, { count, colors, power, angle: (-2 * Math.PI) / 3, spread: 0.6, size: 10, ttl: 240 });
}

/** Confetti raining from the top edge for `ms`. */
export function rain(ms: number, colors: readonly string[] = PALETTE): void {
  const until = performance.now() + ms;
  const drop = () => {
    const w = window.innerWidth;
    for (let i = 0; i < 6; i += 1) {
      add({
        x: rand(0, w),
        y: -12,
        vx: rand(-1.5, 1.5),
        vy: rand(1, 4),
        color: pickOf(colors),
        shape: pickOf(["rect", "ribbon", "circle", "star"] as const),
        size: rand(7, 12),
        gravity: 0.06,
        drag: 0.99,
        ttl: 320,
      });
    }
    start();
    if (performance.now() < until) later(60, drop);
  };
  drop();
}

/** Glowing sparks that radiate out and hang, like a firework's shell. */
function shell(at: Point, colors: readonly string[], size: number): void {
  const count = Math.round(70 * size);
  const power = rand(5.5, 7.5) * size;
  const ring = Math.random() < 0.35;
  for (let i = 0; i < count; i += 1) {
    const a = (i / count) * Math.PI * 2 + rand(-0.05, 0.05);
    const v = ring ? power : power * Math.sqrt(Math.random());
    add({
      x: at.x,
      y: at.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      color: pickOf(colors),
      shape: "spark",
      size: rand(1.6, 2.6),
      gravity: 0.07,
      drag: 0.955,
      ttl: rand(70, 110),
      twinkle: Math.random() < 0.5,
    });
  }
  glows.push({ color: colors[0], life: 0, ttl: 22, strength: 0.12 * size });
}

export interface FireworksOpts {
  count?: number;
  /** Spread the launches over this long. */
  ms?: number;
  onLaunch?: () => void;
  onBurst?: () => void;
}

/** A fireworks show: rockets climb from the bottom and burst in color. */
export function fireworks(o: FireworksOpts = {}): void {
  const count = o.count ?? 7;
  const ms = o.ms ?? 2600;
  const sets = [PALETTE, GOLD, ["#FF375F", "#FF6482", "#FFD60A"], ["#64D2FF", "#0A84FF", "#FFFFFF"], ["#30D158", "#FFD60A", "#FFFFFF"], ["#BF5AF2", "#FF6482", "#64D2FF"]];
  for (let i = 0; i < count; i += 1) {
    later(i === 0 ? 0 : (i / count) * ms + rand(-120, 120), () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const x = rand(w * 0.15, w * 0.85);
      const peak = rand(h * 0.12, h * 0.42);
      const ttl = rand(38, 52);
      const colors = pickOf(sets);
      rockets.push({
        x,
        y: h + 8,
        vx: rand(-1.2, 1.2),
        vy: -(h + 8 - peak) / ttl - 0.5,
        life: 0,
        ttl,
        color: colors[0],
        burst: (at) => {
          shell(at, colors, rand(0.9, 1.35));
          o.onBurst?.();
        },
      });
      o.onLaunch?.();
      start();
    });
  }
}

/** Concentric rings rippling out from a point. */
export function ripples(at: Point, color: string, count = 3, gap = 9): void {
  for (let i = 0; i < count; i += 1) {
    rings.push({ x: at.x, y: at.y, r: 6, vr: 3.2, width: 3, color, life: 0, ttl: 48, delay: i * gap });
  }
  start();
}

/** Text glyphs flung out of a point (</> for an OA, ✓ marks, …). */
export function glyphs(at: Point, chars: readonly string[], colors: readonly string[], count = 22): void {
  for (let i = 0; i < count; i += 1) {
    const a = -Math.PI / 2 + rand(-1.1, 1.1);
    const v = rand(5, 10);
    add({
      x: at.x,
      y: at.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v,
      shape: "glyph",
      glyph: pickOf(chars),
      color: pickOf(colors),
      size: rand(13, 20),
      vr: rand(-0.08, 0.08),
      gravity: 0.2,
      drag: 0.97,
      ttl: rand(90, 130),
    });
  }
  start();
}

/** Sparkles drifting upward, twinkling. */
export function floaters(at: Point, colors: readonly string[], count = 26, spread = 120): void {
  for (let i = 0; i < count; i += 1) {
    add({
      x: at.x + rand(-spread / 2, spread / 2),
      y: at.y + rand(-10, 10),
      vx: rand(-0.6, 0.6),
      vy: rand(-3.2, -1.2),
      shape: Math.random() < 0.6 ? "star" : "circle",
      color: pickOf(colors),
      size: rand(5, 10),
      gravity: -0.02,
      drag: 0.99,
      ttl: rand(80, 140),
      twinkle: true,
      sway: rand(0.02, 0.06),
    });
  }
  start();
}

/** Soft glowing orbs rising slowly, like lanterns: hopeful, not loud. */
export function lanterns(at: Point, colors: readonly string[], count = 16): void {
  for (let i = 0; i < count; i += 1) {
    add({
      x: at.x + rand(-80, 80),
      y: at.y + rand(-6, 20),
      vx: rand(-0.3, 0.3),
      vy: rand(-1.6, -0.7),
      shape: "orb",
      color: pickOf(colors),
      size: rand(11, 20),
      gravity: -0.004,
      drag: 0.995,
      ttl: rand(150, 210),
      sway: rand(0.03, 0.06),
    });
  }
  start();
}

/** A small grey puff, for clearing something away. */
export function poof(at: Point, color = "#8E8E93"): void {
  for (let i = 0; i < 18; i += 1) {
    const a = rand(0, Math.PI * 2);
    const v = rand(1.5, 4.5);
    add({
      x: at.x,
      y: at.y,
      vx: Math.cos(a) * v,
      vy: Math.sin(a) * v - 0.6,
      shape: "orb",
      color,
      size: rand(4, 9),
      gravity: -0.03,
      drag: 0.9,
      ttl: rand(28, 42),
    });
  }
  start();
}

/** A soft full-screen wash of color. */
export function flash(color: string, strength = 0.18, ttl = 30): void {
  glows.push({ color, life: 0, ttl, strength });
  start();
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

function drawStar(c: CanvasRenderingContext2D, r: number): void {
  c.beginPath();
  for (let i = 0; i < 10; i += 1) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  c.closePath();
  c.fill();
}

function frame(now: number): void {
  const c = ctx2d;
  if (!c || !canvas) {
    raf = 0;
    return;
  }
  const dt = Math.min(3, (now - last) / 16.667);
  last = now;
  const light = isLight();

  c.setTransform(1, 0, 0, 1, 0, 0);
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);

  for (let i = glows.length - 1; i >= 0; i -= 1) {
    const g = glows[i];
    g.life += dt;
    if (g.life >= g.ttl) {
      glows.splice(i, 1);
      continue;
    }
    c.globalAlpha = g.strength * (1 - g.life / g.ttl);
    c.fillStyle = g.color;
    c.fillRect(0, 0, window.innerWidth, window.innerHeight);
  }

  for (let i = rings.length - 1; i >= 0; i -= 1) {
    const r = rings[i];
    if (r.delay > 0) {
      r.delay -= dt;
      continue;
    }
    r.life += dt;
    if (r.life >= r.ttl) {
      rings.splice(i, 1);
      continue;
    }
    const t = r.life / r.ttl;
    r.r += r.vr * dt * (1 - t * 0.6);
    c.globalAlpha = (1 - t) * 0.9;
    c.strokeStyle = r.color;
    c.lineWidth = r.width * (1 - t * 0.5);
    c.beginPath();
    c.arc(r.x, r.y, r.r, 0, Math.PI * 2);
    c.stroke();
  }

  for (let i = rockets.length - 1; i >= 0; i -= 1) {
    const k = rockets[i];
    k.life += dt;
    k.x += k.vx * dt;
    k.y += k.vy * dt;
    k.vy += 0.02 * dt;
    // A short spark trail behind the rocket.
    if (Math.random() < 0.8) {
      add({ x: k.x, y: k.y, vx: rand(-0.4, 0.4), vy: rand(0.5, 1.5), shape: "spark", color: "#FFE9A8", size: 1.4, gravity: 0.03, drag: 0.92, ttl: 18 });
    }
    if (k.life >= k.ttl) {
      rockets.splice(i, 1);
      k.burst({ x: k.x, y: k.y });
    }
  }

  for (let i = particles.length - 1; i >= 0; i -= 1) {
    const p = particles[i];
    p.life += dt;
    if (p.life >= p.ttl || p.y > window.innerHeight + 60) {
      particles.splice(i, 1);
      continue;
    }
    const drag = Math.pow(p.drag, dt);
    p.vx *= drag;
    p.vy = p.vy * drag + p.gravity * dt;
    if (p.sway) p.vx += Math.sin((p.life + i) * p.sway) * 0.05 * dt;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.rot += p.vr * dt;
    p.flip += p.vflip * dt;

    const t = p.life / p.ttl;
    let alpha = t < 0.75 ? 1 : 1 - (t - 0.75) / 0.25;
    if (p.twinkle) alpha *= 0.55 + 0.45 * Math.sin(p.life * 0.6 + i);
    if (alpha <= 0) continue;
    c.globalAlpha = alpha;
    // Light adds up into a glow on a dark page; everything else (and emoji,
    // which "lighter" bleaches white) paints normally.
    c.globalCompositeOperation = !light && (p.shape === "spark" || p.shape === "orb") ? "lighter" : "source-over";
    c.fillStyle = p.color;
    c.strokeStyle = p.color;

    if (p.shape === "spark") {
      c.lineWidth = p.size;
      c.lineCap = "round";
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2);
      c.stroke();
      continue;
    }
    if (p.shape === "orb") {
      const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.size);
      g.addColorStop(0, p.color);
      g.addColorStop(1, "transparent");
      c.fillStyle = g;
      c.beginPath();
      c.arc(p.x, p.y, p.size, 0, Math.PI * 2);
      c.fill();
      continue;
    }

    c.save();
    c.translate(p.x, p.y);
    c.rotate(p.rot);
    if (p.shape === "rect" || p.shape === "ribbon") c.scale(1, Math.cos(p.flip));
    switch (p.shape) {
      case "rect":
        c.fillRect(-p.size / 2, -p.size * 0.3, p.size, p.size * 0.6);
        break;
      case "ribbon":
        c.fillRect(-p.size * 0.9, -p.size * 0.16, p.size * 1.8, p.size * 0.32);
        break;
      case "circle":
        c.beginPath();
        c.arc(0, 0, p.size * 0.4, 0, Math.PI * 2);
        c.fill();
        break;
      case "star":
        drawStar(c, p.size * 0.6);
        break;
      case "glyph":
        c.font = `700 ${p.size}px ui-monospace, "Geist Mono", monospace`;
        c.textAlign = "center";
        c.textBaseline = "middle";
        c.fillText(p.glyph ?? "✓", 0, 0);
        break;
    }
    c.restore();
  }
  c.globalCompositeOperation = "source-over";
  c.globalAlpha = 1;

  if (particles.length || rings.length || rockets.length || glows.length || timers.size) {
    raf = requestAnimationFrame(frame);
  } else {
    raf = 0;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// ---------------------------------------------------------------------------
// Element motion (Web Animations, not the canvas)
// ---------------------------------------------------------------------------

/** A springy "boing" on an element: it swells, glows and settles. */
export function pop(el: Element | null, color = "rgba(48, 209, 88, 0.55)"): void {
  if (!(el instanceof HTMLElement) || typeof el.animate !== "function") return;
  el.animate(
    [
      { transform: "scale(1)", boxShadow: `0 0 0 0 ${color}` },
      { transform: "scale(1.06)", boxShadow: `0 0 0 6px ${color}`, offset: 0.35 },
      { transform: "scale(0.98)", offset: 0.7 },
      { transform: "scale(1)", boxShadow: "0 0 0 12px transparent" },
    ],
    { duration: 650, easing: "cubic-bezier(0.34, 1.36, 0.64, 1)" },
  );
}

/**
 * A band of light sweeping across an element, left to right, like a stamp
 * landing. Drawn by a temporary child, since a gradient can't be animated.
 */
export function sweep(el: Element | null, color: string): void {
  if (!(el instanceof HTMLElement) || typeof el.animate !== "function") return;
  if (getComputedStyle(el).position === "static") el.style.position = "relative";
  const clip = document.createElement("span");
  clip.setAttribute("aria-hidden", "true");
  Object.assign(clip.style, {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    borderRadius: "inherit",
  });
  const band = document.createElement("span");
  Object.assign(band.style, {
    position: "absolute",
    inset: "0",
    background: `linear-gradient(90deg, transparent, ${color} 45%, ${color} 55%, transparent)`,
  });
  clip.appendChild(band);
  el.appendChild(clip);
  const anim = band.animate(
    [
      { transform: "translateX(-100%)", opacity: 1 },
      { transform: "translateX(100%)", opacity: 0.6 },
    ],
    { duration: 750, easing: "cubic-bezier(0.32, 0.72, 0, 1)" },
  );
  anim.onfinish = anim.oncancel = () => clip.remove();
}

/** A short shake of the whole page, for the biggest news. */
export function shake(strength = 4): void {
  // The body, not <main>: a transform on <main> would make it the containing
  // block for the fixed toasts inside it, and they'd jump mid-shake.
  const el = document.body;
  if (!(el instanceof HTMLElement) || typeof el.animate !== "function") return;
  const s = strength;
  el.animate(
    [
      { transform: "translate(0, 0)" },
      { transform: `translate(${-s}px, ${s / 2}px)` },
      { transform: `translate(${s}px, ${-s / 2}px)` },
      { transform: `translate(${-s / 2}px, ${s / 3}px)` },
      { transform: `translate(${s / 3}px, 0)` },
      { transform: "translate(0, 0)" },
    ],
    { duration: 420, easing: "ease-out" },
  );
}
