import type { AppStatus } from "@/generated/prisma/enums";
import { addDays, weekStart } from "./moments";

/**
 * Achievements: small badges for things worth noticing. Pure: the facts come
 * in (lib/applications/progress.ts loads them), and every badge is DERIVED
 * from them with the moment it was earned, so nothing here needs storing.
 * Only which ones have already been announced is stored, so a badge pops
 * once.
 */

export interface AppliedFact {
  applicationId: string;
  /** When it was sent: appliedAt, else its first status change. */
  at: Date;
  faangPlus: boolean;
  deadline: Date | null;
  /** Only the date is known (a CSV import stores midnight UTC): no time of day. */
  dateOnly?: boolean;
}

export interface EventFact {
  applicationId: string;
  status: AppStatus;
  at: Date;
}

export interface AchievementFacts {
  /** One per application currently counted as sent. */
  applied: readonly AppliedFact[];
  /** Every status change, any order. */
  events: readonly EventFact[];
  weeklyGoal: number | null;
  timeZone?: string;
}

export interface AchievementDef {
  id: string;
  emoji: string;
  title: string;
  /** How to earn it, shown while locked too. */
  description: string;
}

export interface Achievement extends AchievementDef {
  /** When it was earned, or null while locked. */
  unlockedAt: Date | null;
  /** Locked badges with a count show how close you are. */
  progress?: { have: number; need: number };
}

const DAY_MS = 86_400_000;

function localDay(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/**
 * The calendar day an application was sent. A date-only import is that date
 * as written: its midnight UTC would be the evening before in New York.
 */
export function sentDay(a: AppliedFact, timeZone?: string): string {
  return a.dateOnly ? a.at.toISOString().slice(0, 10) : localDay(a.at, timeZone);
}

/** The local hour, or null when only the date is known. */
function sentHour(a: AppliedFact, timeZone?: string): number | null {
  return a.dateOnly ? null : localHour(a.at, timeZone);
}

function localHour(d: Date, timeZone?: string): number {
  const h = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(d);
  return Number(h) % 24;
}

function byTime<T extends { at: Date }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** The moment the n-th item (1-based) arrived, or null if there aren't n. */
function nth<T extends { at: Date }>(sorted: readonly T[], n: number): Date | null {
  return sorted.length >= n ? sorted[n - 1].at : null;
}

/** Distinct applications whose events reached any of `statuses`, first time each. */
function firstReaching(events: readonly EventFact[], statuses: readonly AppStatus[]): EventFact[] {
  const want = new Set(statuses);
  const first = new Map<string, EventFact>();
  for (const e of byTime(events)) {
    if (want.has(e.status) && !first.has(e.applicationId)) first.set(e.applicationId, e);
  }
  return [...first.values()];
}

type Rule = (f: AchievementFacts, applied: AppliedFact[]) => { at: Date | null; have?: number; need?: number };

function count(need: number): Rule {
  return (_f, applied) => ({ at: nth(applied, need), have: Math.min(applied.length, need), need });
}

/** The first day a streak of `need` days was completed. */
function streak(need: number): Rule {
  return (f, applied) => {
    const days = new Set<string>();
    let best = 0;
    for (const a of applied) {
      const day = sentDay(a, f.timeZone);
      if (days.has(day)) continue;
      days.add(day);
      let n = 0;
      for (let d = day; days.has(d); d = addDays(d, -1)) n += 1;
      best = Math.max(best, n);
      if (n >= need) return { at: a.at };
    }
    return { at: null, have: Math.min(best, need), need };
  };
}

const RULES: ReadonlyArray<AchievementDef & { rule: Rule }> = [
  { id: "first-step", emoji: "🌱", title: "First step", description: "Send your first application.", rule: count(1) },
  { id: "ten", emoji: "🔟", title: "Double digits", description: "Send 10 applications.", rule: count(10) },
  { id: "twenty-five", emoji: "🎒", title: "Getting serious", description: "Send 25 applications.", rule: count(25) },
  { id: "fifty", emoji: "🏅", title: "Half century", description: "Send 50 applications.", rule: count(50) },
  { id: "hundred", emoji: "💯", title: "Centurion", description: "Send 100 applications.", rule: count(100) },
  {
    id: "sprinter",
    emoji: "⚡",
    title: "Sprinter",
    description: "Send 10 applications in one day.",
    rule: (f, applied) => {
      const perDay = new Map<string, number>();
      let best = 0;
      for (const a of applied) {
        const day = sentDay(a, f.timeZone);
        const n = (perDay.get(day) ?? 0) + 1;
        perDay.set(day, n);
        best = Math.max(best, n);
        if (n === 10) return { at: a.at };
      }
      return { at: null, have: best, need: 10 };
    },
  },
  { id: "on-fire", emoji: "🔥", title: "On fire", description: "Apply 7 days in a row.", rule: streak(7) },
  { id: "two-weeks", emoji: "☄️", title: "Unstoppable", description: "Apply 14 days in a row.", rule: streak(14) },
  {
    id: "goal-getter",
    emoji: "🎯",
    title: "Goal getter",
    description: "Meet your weekly goal.",
    rule: (f, applied) => {
      const goal = f.weeklyGoal;
      if (!goal) return { at: null };
      const perWeek = new Map<string, number>();
      let best = 0;
      for (const a of applied) {
        const week = weekStart(sentDay(a, f.timeZone));
        const n = (perWeek.get(week) ?? 0) + 1;
        perWeek.set(week, n);
        best = Math.max(best, n);
        if (n === goal) return { at: a.at };
      }
      return { at: null, have: best, need: goal };
    },
  },
  {
    id: "night-owl",
    emoji: "🦉",
    title: "Night owl",
    description: "Apply between midnight and 5am.",
    rule: (f, applied) => ({
      at:
        applied.find((a) => {
          const h = sentHour(a, f.timeZone);
          return h !== null && h < 5;
        })?.at ?? null,
    }),
  },
  {
    id: "early-bird",
    emoji: "🐦",
    title: "Early bird",
    description: "Apply between 5am and 8am.",
    rule: (f, applied) => ({
      at: applied.find((a) => {
        const h = sentHour(a, f.timeZone);
        return h !== null && h >= 5 && h < 8;
      })?.at ?? null,
    }),
  },
  {
    id: "big-tech",
    emoji: "🏙️",
    title: "Big Tech sweep",
    description: "Apply to 5 FAANG+ companies within 7 days.",
    rule: (_f, applied) => {
      const big = applied.filter((a) => a.faangPlus);
      let best = 0;
      for (let i = 0; i < big.length; i++) {
        // Window ending at big[i]: everything from the last 7 days.
        let j = i;
        while (j > 0 && big[i].at.getTime() - big[j - 1].at.getTime() < 7 * DAY_MS) j -= 1;
        const n = i - j + 1;
        best = Math.max(best, n);
        if (n >= 5) return { at: big[i].at };
      }
      return { at: null, have: best, need: 5 };
    },
  },
  {
    id: "closer",
    emoji: "⏰",
    title: "Closer",
    description: "Apply within 48 hours of a deadline.",
    rule: (_f, applied) => ({
      at:
        applied.find((a) => {
          if (!a.deadline) return false;
          const left = a.deadline.getTime() - a.at.getTime();
          return left >= 0 && left <= 2 * DAY_MS;
        })?.at ?? null,
    }),
  },
  {
    id: "foot-in-door",
    emoji: "🚪",
    title: "Foot in the door",
    description: "Get your first OA, phone screen or interview.",
    rule: (f) => ({ at: nth(byTime(firstReaching(f.events, ["OA", "PHONE_SCREEN", "INTERVIEW", "OFFER"])), 1) }),
  },
  {
    id: "in-the-room",
    emoji: "🎤",
    title: "In the room",
    description: "Land an interview.",
    rule: (f) => ({ at: nth(byTime(firstReaching(f.events, ["INTERVIEW", "OFFER"])), 1) }),
  },
  {
    id: "comeback",
    emoji: "💪",
    title: "Comeback",
    description: "Land an interview after 3 rejections.",
    rule: (f) => {
      const rejected = byTime(firstReaching(f.events, ["REJECTED"]));
      const third = nth(rejected, 3);
      if (!third) return { at: null, have: rejected.length, need: 3 };
      const after = byTime(f.events).find((e) => e.status === "INTERVIEW" && e.at.getTime() > third.getTime());
      return { at: after?.at ?? null };
    },
  },
  {
    id: "thick-skin",
    emoji: "🛡️",
    title: "Thick skin",
    description: "Hear back with 10 rejections and keep going.",
    rule: (f) => {
      const rejected = byTime(firstReaching(f.events, ["REJECTED"]));
      return { at: nth(rejected, 10), have: Math.min(rejected.length, 10), need: 10 };
    },
  },
  {
    id: "offer",
    emoji: "🏆",
    title: "Offer!",
    description: "Get an offer.",
    rule: (f) => ({ at: nth(byTime(firstReaching(f.events, ["OFFER"])), 1) }),
  },
];

export const ACHIEVEMENTS: readonly AchievementDef[] = RULES.map(({ id, emoji, title, description }) => ({ id, emoji, title, description }));

/** Every badge, earned or not, in catalog order. */
export function evaluateAchievements(facts: AchievementFacts): Achievement[] {
  const applied = byTime(facts.applied);
  return RULES.map(({ rule, ...def }) => {
    const r = rule(facts, applied);
    const progress = r.at === null && r.need ? { have: r.have ?? 0, need: r.need } : undefined;
    return { ...def, unlockedAt: r.at, ...(progress ? { progress } : {}) };
  });
}

/**
 * Badges to announce now: earned, and not announced before. With no record
 * yet (the first run), only badges earned in the last few minutes count, so
 * turning the feature on doesn't pop every historical badge at once.
 */
export function newlyUnlocked(
  all: readonly Achievement[],
  announced: ReadonlySet<string> | null,
  now: Date,
): Achievement[] {
  const fresh = now.getTime() - 5 * 60_000;
  return all.filter(
    (a) => a.unlockedAt !== null && (announced ? !announced.has(a.id) : a.unlockedAt.getTime() >= fresh),
  );
}

/** For the heatmap: applications sent per local day. */
export function appliedDays(applied: readonly AppliedFact[], timeZone?: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const a of applied) {
    const day = sentDay(a, timeZone);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  return days;
}
