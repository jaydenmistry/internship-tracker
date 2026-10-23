/**
 * Celebration sounds, synthesized with Web Audio: no files to load, nothing
 * to fetch, and every sound tuned to sit together (C major, bell-like).
 *
 * On by default; the speaker button in the sidebar turns it off, kept in the
 * `sound` cookie like the other display preferences. Browsers only start
 * audio from a user gesture, so callers `unlock()` synchronously inside the
 * click or key handler and may play later (after a server reply) freely.
 */

import { writePreference } from "@/components/preferences";

export const SOUND_COOKIE = "sound";
const CHANGE_EVENT = "celebrate:sound";

export function isSoundOn(): boolean {
  if (typeof document === "undefined") return true;
  return !/(?:^|;\s*)sound=off(?:;|$)/.test(document.cookie);
}

export function setSoundOn(on: boolean): void {
  writePreference(SOUND_COOKIE, on ? "on" : "off");
  window.dispatchEvent(new Event(CHANGE_EVENT));
  if (on) {
    unlock();
    play("toggle");
  }
}

export function onSoundChange(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

// ---------------------------------------------------------------------------
// Audio graph
// ---------------------------------------------------------------------------

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noiseBuffer: AudioBuffer | null = null;

/** Creates or resumes the context. Call from inside a user gesture. */
export function unlock(): void {
  if (!isSoundOn() || typeof window === "undefined") return;
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      ctx = new Ctor();
      // A gentle limiter so stacked sounds (fireworks) never clip.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -14;
      limiter.ratio.value = 6;
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(limiter).connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
  } catch {
    ctx = null;
  }
}

function ready(): { ctx: AudioContext; out: GainNode } | null {
  if (!isSoundOn() || !ctx || !master) return null;
  return { ctx, out: master };
}

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Frequency to glide to over the note. */
  glide?: number;
  /** Adds quiet inharmonic partials so it rings like a bell. */
  bell?: boolean;
}

function tone(freq: number, at: number, dur: number, o: ToneOpts = {}): void {
  const a = ready();
  if (!a) return;
  const t = a.ctx.currentTime + at;
  const partials: Array<[number, number]> = o.bell ? [[1, 1], [2.76, 0.18], [5.4, 0.06]] : [[1, 1]];
  for (const [ratio, level] of partials) {
    const osc = a.ctx.createOscillator();
    const g = a.ctx.createGain();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(freq * ratio, t);
    if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.glide * ratio, t + dur);
    const peak = (o.gain ?? 0.3) * level;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + (o.attack ?? 0.005));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(g).connect(a.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }
}

interface NoiseOpts {
  gain?: number;
  filter?: BiquadFilterType;
  freq?: number;
  /** Filter frequency to sweep to. */
  sweep?: number;
  q?: number;
}

function noise(at: number, dur: number, o: NoiseOpts = {}): void {
  const a = ready();
  if (!a) return;
  if (!noiseBuffer) {
    noiseBuffer = a.ctx.createBuffer(1, a.ctx.sampleRate, a.ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  const t = a.ctx.currentTime + at;
  const src = a.ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filter = a.ctx.createBiquadFilter();
  filter.type = o.filter ?? "bandpass";
  filter.frequency.setValueAtTime(o.freq ?? 3000, t);
  if (o.sweep) filter.frequency.exponentialRampToValueAtTime(o.sweep, t + dur);
  filter.Q.value = o.q ?? 0.8;
  const g = a.ctx.createGain();
  g.gain.setValueAtTime(o.gain ?? 0.2, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter).connect(g).connect(a.out);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.05);
}

// Equal temperament, A4 = 440.
const NOTE: Record<string, number> = {
  C4: 261.63, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0,
  C5: 523.25, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880.0, B5: 987.77,
  C6: 1046.5, D6: 1174.66, E6: 1318.51, G6: 1567.98, A6: 1760.0, C7: 2093.0, E7: 2637.02,
};

function arpeggio(notes: string[], start: number, step: number, o: ToneOpts & { dur?: number } = {}): void {
  notes.forEach((n, i) => tone(NOTE[n], start + i * step, o.dur ?? 0.5, { bell: true, gain: 0.22, ...o }));
}

function shimmer(at: number, dur = 0.6, gain = 0.06): void {
  noise(at, dur, { filter: "highpass", freq: 7000, gain });
  for (let i = 0; i < 6; i += 1) {
    tone(NOTE.C7 * (1 + Math.random() * 0.6), at + i * 0.05, 0.12, { gain: 0.035 });
  }
}

/** A firework bursting: a thump under a crackle. */
export function boom(at = 0, size = 1): void {
  tone(90, at, 0.6, { glide: 38, gain: 0.45 * size, type: "sine" });
  noise(at, 0.7, { filter: "lowpass", freq: 900, sweep: 120, gain: 0.45 * size });
  for (let i = 0; i < 9; i += 1) {
    noise(at + 0.12 + Math.random() * 0.6, 0.03, { filter: "highpass", freq: 4000, gain: 0.08 * size });
  }
}

/** A rocket going up. */
export function whistle(at = 0, dur = 0.8): void {
  tone(700 + Math.random() * 200, at, dur, { glide: 2200 + Math.random() * 500, gain: 0.04, attack: 0.05 });
  noise(at, dur, { filter: "bandpass", freq: 1200, sweep: 5000, gain: 0.05, q: 4 });
}

export type SoundName =
  | "applied"
  | "appliedBig"
  | "milestone"
  | "bonus"
  | "oa"
  | "phone"
  | "interview"
  | "offer"
  | "rejected"
  | "save"
  | "dismiss"
  | "undo"
  | "toggle";

/** Plays one named sound if sound is on. Never throws. */
export function play(name: SoundName): void {
  if (!ready()) return;
  try {
    switch (name) {
      case "applied":
        // A pop, then a bright rising chime.
        tone(900, 0, 0.08, { glide: 260, gain: 0.35, type: "triangle" });
        arpeggio(["C6", "E6", "G6"], 0.05, 0.07);
        shimmer(0.12, 0.5);
        break;
      case "appliedBig":
        tone(900, 0, 0.08, { glide: 260, gain: 0.35, type: "triangle" });
        arpeggio(["C6", "E6", "G6", "C7", "E7"], 0.05, 0.065, { dur: 0.7 });
        shimmer(0.15, 0.8, 0.08);
        break;
      case "milestone":
        // Two cannons, then a fanfare that resolves on a held chord.
        boom(0, 0.8);
        boom(0.12, 0.8);
        arpeggio(["G5", "C6", "E6", "G6"], 0.18, 0.09, { type: "triangle", dur: 0.35 });
        ["C6", "E6", "G6", "C7"].forEach((n) => tone(NOTE[n], 0.56, 1.4, { bell: true, gain: 0.14, attack: 0.02 }));
        tone(NOTE.C5, 0.56, 1.4, { type: "sawtooth", gain: 0.03, attack: 0.05 });
        shimmer(0.6, 1.2, 0.09);
        break;
      case "bonus":
        // A lift on top of the applied chime: first of the day, or a streak.
        arpeggio(["G6", "C7", "E7"], 0, 0.06, { dur: 0.45, gain: 0.14 });
        noise(0, 0.5, { filter: "bandpass", freq: 900, sweep: 2600, gain: 0.07, q: 0.7 });
        break;
      case "oa":
        // Typewriter keys, then the carriage-return bell.
        for (let i = 0; i < 6; i += 1) noise(i * 0.055, 0.025, { filter: "bandpass", freq: 2500 + i * 150, gain: 0.28, q: 2 });
        tone(NOTE.A6, 0.36, 0.9, { bell: true, gain: 0.22 });
        tone(NOTE.E6, 0.36, 0.9, { bell: true, gain: 0.1 });
        break;
      case "phone":
        // Two soft trills, like an old phone.
        for (let ring = 0; ring < 2; ring += 1) {
          for (let i = 0; i < 8; i += 1) {
            tone(i % 2 ? NOTE.G6 : NOTE.E6, ring * 0.42 + i * 0.03, 0.05, { gain: 0.12 });
          }
        }
        arpeggio(["E6", "G6", "C7"], 0.9, 0.06, { dur: 0.6 });
        break;
      case "interview":
        // A warm chord swells in, sparkles on top.
        ["C5", "E5", "G5", "B5", "D6"].forEach((n, i) =>
          tone(NOTE[n], i * 0.06, 1.3, { bell: true, gain: 0.13, attack: 0.08 }),
        );
        arpeggio(["G6", "C7", "E7"], 0.4, 0.08, { dur: 0.5, gain: 0.12 });
        shimmer(0.35, 0.9, 0.08);
        break;
      case "offer":
        // The fireworks show plays its own whistles and booms; this is the
        // fanfare over the top.
        arpeggio(["C5", "E5", "G5", "C6"], 0, 0.11, { type: "triangle", dur: 0.3, gain: 0.2 });
        ["C6", "E6", "G6", "C7", "E7"].forEach((n) => tone(NOTE[n], 0.45, 2, { bell: true, gain: 0.12, attack: 0.02 }));
        tone(NOTE.C4, 0.45, 2, { type: "sawtooth", gain: 0.035, attack: 0.08 });
        shimmer(0.5, 1.6, 0.1);
        break;
      case "rejected":
        // Gentle and warm, not a sad trombone: a soft chord that rises.
        ["F4", "A4", "C5"].forEach((n, i) => tone(NOTE[n], i * 0.09, 1.1, { gain: 0.1, attack: 0.06 }));
        tone(NOTE.E5, 0.4, 0.9, { bell: true, gain: 0.08, attack: 0.04 });
        break;
      case "save":
        tone(1200, 0, 0.09, { glide: 1900, gain: 0.16, type: "triangle" });
        tone(NOTE.E7, 0.06, 0.25, { bell: true, gain: 0.06 });
        break;
      case "dismiss":
        noise(0, 0.22, { filter: "bandpass", freq: 3200, sweep: 500, gain: 0.18, q: 1.2 });
        break;
      case "undo":
        tone(900, 0, 0.12, { glide: 450, gain: 0.14, type: "triangle" });
        break;
      case "toggle":
        tone(NOTE.C6, 0, 0.12, { bell: true, gain: 0.12 });
        tone(NOTE.G6, 0.07, 0.18, { bell: true, gain: 0.12 });
        break;
    }
  } catch {
    // Sound is decoration; a broken audio stack must never break a click.
  }
}
