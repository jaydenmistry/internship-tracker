import type { AppStatus } from "@/generated/prisma/enums";

/**
 * Which status changes celebrate, and what they say. Pure: no DOM, no clock,
 * no I/O, so the browser (to pick the show) and the server (milestones,
 * streaks) agree, and the rules are unit-testable.
 *
 * Only real progress celebrates. Picking the status a listing already has,
 * moving backwards, or correcting a mistake (closed → applied) stays quiet,
 * so the confetti always means something happened.
 */

export type Moment = "applied" | "oa" | "phone" | "interview" | "offer" | "rejected";

/** Pipeline position; statuses absent here (CLOSED, SKIPPED) aren't stages. */
const STAGE: Partial<Record<AppStatus, number>> = {
  NOT_APPLIED: 0,
  APPLIED: 1,
  OA: 2,
  PHONE_SCREEN: 3,
  INTERVIEW: 4,
  OFFER: 5,
};

const MOMENT_OF: Partial<Record<AppStatus, Moment>> = {
  APPLIED: "applied",
  OA: "oa",
  PHONE_SCREEN: "phone",
  INTERVIEW: "interview",
  OFFER: "offer",
};

/** Statuses an employer can reject from: anything that was sent. */
const SENT: ReadonlySet<AppStatus> = new Set<AppStatus>(["APPLIED", "OA", "PHONE_SCREEN", "INTERVIEW"]);

/**
 * The celebration for moving `from` → `to`, or null for none. `from` null is
 * "no application yet". Applying counts from not-applied or skipped; every
 * later stage counts when it's a step forward (APPLIED → INTERVIEW skips
 * ahead and still celebrates). A rejection gets its own gentle moment, but
 * only for something that was actually sent.
 */
export function momentFor(from: AppStatus | null, to: AppStatus): Moment | null {
  const was = from ?? "NOT_APPLIED";
  if (was === to) return null;
  if (to === "APPLIED") return was === "NOT_APPLIED" || was === "SKIPPED" ? "applied" : null;
  if (to === "REJECTED") return SENT.has(was) ? "rejected" : null;
  const target = STAGE[to];
  const current = STAGE[was];
  if (target === undefined || current === undefined) return null;
  return target > current ? (MOMENT_OF[to] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Progress: totals, streaks, milestones
// ---------------------------------------------------------------------------

export interface ApplyProgress {
  /** Applications ever sent (anything but not-applied or skipped). */
  total: number;
  /** Distinct applications marked applied today, this one included. */
  today: number;
  /** Consecutive days, ending today, with at least one application. */
  streak: number;
  /** `total` when it just landed on a milestone, else null. */
  milestone: number | null;
}

export const MILESTONES: readonly number[] = [1, 5, 10, 25, 50, 75, 100, 150, 200, 250, 300, 400, 500, 750, 1000];

export function milestoneFor(total: number): number | null {
  return MILESTONES.includes(total) ? total : null;
}

/** "YYYY-MM-DD" → the day before, zone-free. */
function previousDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** Consecutive days with an application, counting back from `today`. */
export function streakLength(days: ReadonlySet<string>, today: string): number {
  let n = 0;
  for (let day = today; days.has(day); day = previousDay(day)) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export interface CelebrationContext {
  company: string;
  /** Score 70+, saved, or a FAANG+ company: gold confetti. */
  dream?: boolean;
  /** Only for "applied", once the server answered. */
  progress?: ApplyProgress;
  /** Injected so tests are deterministic; Math.random in the app. */
  random?: () => number;
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

const LINES: Record<Moment, readonly string[]> = {
  applied: [
    "Applied to {c}! 🚀",
    "Sent! {c} is lucky to get this one ✉️",
    "Shot taken at {c} 🎯",
    "Another one in the books: {c} 📚",
    "{c}, incoming! 💌",
    "Boom. {c} has your application 💥",
  ],
  oa: [
    "OA unlocked at {c} 💻 You've got this.",
    "{c} sent an online assessment. Time to cook 🧑‍💻",
    "Assessment from {c}! Show them what you can do ⌨️",
  ],
  phone: [
    "📞 {c} wants to talk!",
    "Phone screen with {c}! Ring ring 📞",
    "{c} is calling. Big step! 📱",
  ],
  interview: [
    "🌟 Interview at {c}!",
    "You're in the room at {c} 🌟",
    "{c} wants to meet you. Let's go! ✨",
  ],
  offer: [
    "🏆 OFFER from {c}!!! You did it.",
    "🎆 {c} made you an offer!",
    "🥳 You got the offer from {c}!",
  ],
  rejected: [
    "{c} passed. Their loss. On to the next 💪",
    "Not this one. Every no gets you closer 🌱",
    "{c} wasn't the one. Plenty more out there 🌤️",
  ],
};

const MILESTONE_LINES: Record<number, string> = {
  1: "🎉 Your first application! The journey starts here.",
  100: "💯 100 applications sent! Absolute machine.",
};

/** The toast line for a celebration. */
export function celebrationMessage(moment: Moment, ctx: CelebrationContext): string {
  const random = ctx.random ?? Math.random;
  const c = ctx.company;
  const p = moment === "applied" ? ctx.progress : undefined;

  if (p?.milestone) {
    const line = MILESTONE_LINES[p.milestone] ?? `🎉 ${p.milestone} applications sent!`;
    return withStreak(`${line} (${c})`, p);
  }

  let line: string;
  if (moment === "applied" && p?.today === 1) line = `First application of the day: ${c}! ☀️`;
  else if (moment === "applied" && ctx.dream) line = `Dream role alert: applied to ${c} ✨`;
  else line = pick(LINES[moment], random).replaceAll("{c}", c);
  return p ? withStreak(line, p) : line;
}

function withStreak(line: string, p: ApplyProgress): string {
  return p.streak >= 2 ? `${line} · 🔥 ${p.streak}-day streak` : line;
}
