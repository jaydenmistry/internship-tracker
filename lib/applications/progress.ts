import { z } from "zod";
import { prisma } from "@/lib/db";
import { calendarDate } from "@/lib/alerts/build";
import { milestoneFor, streakLength, weekStart, type ApplyProgress } from "@/lib/celebrate/moments";
import {
  appliedDays,
  evaluateAchievements,
  newlyUnlocked,
  sentDay,
  type Achievement,
  type AchievementFacts,
  type AppliedFact,
} from "@/lib/celebrate/achievements";
import { buildHeatmap, type Heatmap } from "@/lib/celebrate/heatmap";

/**
 * The numbers behind the fun parts: celebrations (total, today, streak,
 * weekly goal), the activity heatmap, and achievements. Days are calendar
 * days in ALERT_TIMEZONE, like every other "today" in the app.
 *
 * Read right after the status change is written, so the new application is
 * already counted. A streak longer than the lookback window just stops
 * counting there.
 */
const STREAK_LOOKBACK_DAYS = 400;

/** Statuses that count as sent. */
const NOT_SENT = ["NOT_APPLIED", "SKIPPED"] as const;

function zoneOf(timeZone?: string): string | undefined {
  return timeZone ?? (process.env.ALERT_TIMEZONE?.trim() || undefined);
}

// ---------------------------------------------------------------------------
// Weekly goal
// ---------------------------------------------------------------------------

export const WEEKLY_GOAL_KEY = "apply.weeklyGoal";
export const DEFAULT_WEEKLY_GOAL = 10;
export const MAX_WEEKLY_GOAL = 100;

const goalSchema = z.object({ goal: z.number().int().min(1).max(MAX_WEEKLY_GOAL).nullable() });

/** The weekly goal; null when turned off. Unset means the default. */
export async function loadWeeklyGoal(): Promise<number | null> {
  const row = await prisma.setting.findUnique({ where: { key: WEEKLY_GOAL_KEY } });
  if (!row) return DEFAULT_WEEKLY_GOAL;
  const parsed = goalSchema.safeParse(row.value);
  return parsed.success ? parsed.data.goal : DEFAULT_WEEKLY_GOAL;
}

export async function saveWeeklyGoal(goal: number | null): Promise<void> {
  const value = goalSchema.parse({ goal });
  await prisma.setting.upsert({
    where: { key: WEEKLY_GOAL_KEY },
    create: { key: WEEKLY_GOAL_KEY, value },
    update: { value },
  });
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Every application counted as sent, with when it was sent: `appliedAt`, else
 * its first status change (a role moved straight to OA never passed through
 * APPLIED), else when the row was made.
 *
 * A bulk import with a date but no time stores midnight UTC (see
 * parseAppliedDate); those count on the date as written and carry no hour.
 */
function isDateOnly(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

type SentFact = AppliedFact & { listingId: string | null };

async function loadAppliedFacts(): Promise<SentFact[]> {
  const apps = await prisma.application.findMany({
    where: { status: { notIn: [...NOT_SENT] } },
    select: {
      id: true,
      listingId: true,
      appliedAt: true,
      createdAt: true,
      listing: { select: { deadline: true, company: { select: { faangPlus: true } } } },
      events: { select: { occurredAt: true }, orderBy: { occurredAt: "asc" }, take: 1 },
    },
  });
  return apps.map((a) => ({
    applicationId: a.id,
    listingId: a.listingId,
    at: a.appliedAt ?? a.events[0]?.occurredAt ?? a.createdAt,
    dateOnly: a.appliedAt !== null && isDateOnly(a.appliedAt),
    faangPlus: a.listing?.company.faangPlus ?? false,
    deadline: a.listing?.deadline ?? null,
  }));
}

async function loadFacts(timeZone?: string): Promise<AchievementFacts> {
  const applied = await loadAppliedFacts();
  const events = await prisma.statusEvent.findMany({
    select: { applicationId: true, toStatus: true, occurredAt: true },
  });
  const weeklyGoal = await loadWeeklyGoal();
  return {
    applied,
    events: events.map((e) => ({ applicationId: e.applicationId, status: e.toStatus, at: e.occurredAt })),
    weeklyGoal,
    timeZone,
  };
}

/** Sent this week (Monday start), and the goal. For the sidebar ring too. */
export interface WeekProgress {
  week: number;
  goal: number | null;
}

function inThisWeek(a: AppliedFact, now: Date, timeZone?: string): boolean {
  const today = calendarDate(now, timeZone);
  const day = sentDay(a, timeZone);
  return day >= weekStart(today) && day <= today;
}

async function weekFrom(applied: readonly SentFact[], now: Date, timeZone?: string): Promise<WeekProgress> {
  const goal = await loadWeeklyGoal();
  return { week: applied.filter((a) => inThisWeek(a, now, timeZone)).length, goal };
}

export async function loadWeekProgress(opts: { now?: Date; timeZone?: string } = {}): Promise<WeekProgress> {
  return weekFrom(await loadAppliedFacts(), opts.now ?? new Date(), zoneOf(opts.timeZone));
}

/** The application a status change was about, by either id. */
export type JustSent = { applicationId?: string; listingId?: string };

/** How recently an application must have been sent to count as "just now". */
const JUST_NOW_MS = 2 * 60_000;

// ---------------------------------------------------------------------------
// Celebration progress
// ---------------------------------------------------------------------------

/**
 * `justSent` names the application this change was about. The goal counts as
 * reached only when THAT application was first sent just now and is what
 * brought the week to the goal — so re-applying one sent earlier (its
 * appliedAt is kept) or an unrelated change can't re-fire the celebration.
 * Without it (tests), the count alone decides.
 */
export async function loadApplyProgress(
  opts: { now?: Date; timeZone?: string; justSent?: JustSent } = {},
): Promise<ApplyProgress> {
  const now = opts.now ?? new Date();
  const timeZone = zoneOf(opts.timeZone);

  const total = await prisma.application.count({
    where: { status: { notIn: [...NOT_SENT] } },
  });
  const events = await prisma.statusEvent.findMany({
    where: {
      toStatus: "APPLIED",
      occurredAt: { gte: new Date(now.getTime() - STREAK_LOOKBACK_DAYS * 86_400_000), lte: now },
    },
    select: { applicationId: true, occurredAt: true },
  });

  const today = calendarDate(now, timeZone);
  const days = new Set<string>();
  const appliedToday = new Set<string>();
  for (const e of events) {
    const day = calendarDate(e.occurredAt, timeZone);
    days.add(day);
    if (day === today) appliedToday.add(e.applicationId);
  }

  // The toast's streak counts changes to APPLIED (what you did each day);
  // the week, heatmap and badges count when each application was sent, which
  // also covers roles moved straight to OA or imported with a date.
  const applied = await loadAppliedFacts();
  const { week, goal } = await weekFrom(applied, now, timeZone);
  const sentNow = (() => {
    const j = opts.justSent;
    if (!j) return true;
    const fact = applied.find(
      (a) => (j.applicationId && a.applicationId === j.applicationId) || (j.listingId && a.listingId === j.listingId),
    );
    return !!fact && !fact.dateOnly && now.getTime() - fact.at.getTime() < JUST_NOW_MS && inThisWeek(fact, now, timeZone);
  })();
  return {
    total,
    today: appliedToday.size,
    streak: streakLength(days, today),
    milestone: milestoneFor(total),
    week,
    goal,
    goalReached: goal !== null && week === goal && sentNow,
  };
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

export const ANNOUNCED_KEY = "achievements.announced";
const announcedSchema = z.object({ ids: z.array(z.string().max(100)).max(500) });

export async function loadAchievements(opts: { timeZone?: string } = {}): Promise<Achievement[]> {
  return evaluateAchievements(await loadFacts(zoneOf(opts.timeZone)));
}

/**
 * Badges earned since the last announcement, recorded as announced in the
 * same breath so each one pops exactly once.
 */
export async function announceNewAchievements(opts: { now?: Date; timeZone?: string } = {}): Promise<Achievement[]> {
  const now = opts.now ?? new Date();
  const all = await loadAchievements(opts);
  const row = await prisma.setting.findUnique({ where: { key: ANNOUNCED_KEY } });
  const parsed = row ? announcedSchema.safeParse(row.value) : null;
  const announced = parsed?.success ? new Set(parsed.data.ids) : null;
  const fresh = newlyUnlocked(all, announced, now);

  // First run, or anything new: record everything earned so far, so the
  // historical badges are never announced later either. A union, never a
  // replacement: a badge that re-locks (goal raised, an un-apply) stays
  // announced and won't pop a second time.
  if (announced === null || fresh.length > 0) {
    const ids = new Set([...(announced ?? []), ...all.filter((a) => a.unlockedAt !== null).map((a) => a.id)]);
    const value = { ids: [...ids] };
    await prisma.setting.upsert({
      where: { key: ANNOUNCED_KEY },
      create: { key: ANNOUNCED_KEY, value },
      update: { value },
    });
  }
  return fresh;
}

// ---------------------------------------------------------------------------
// Heatmap
// ---------------------------------------------------------------------------

export async function loadHeatmap(opts: { now?: Date; timeZone?: string } = {}): Promise<Heatmap> {
  const timeZone = zoneOf(opts.timeZone);
  const applied = await loadAppliedFacts();
  return buildHeatmap(appliedDays(applied, timeZone), calendarDate(opts.now ?? new Date(), timeZone));
}

// ---------------------------------------------------------------------------
// For Server Actions
// ---------------------------------------------------------------------------

/** What a status change hands back to the client's celebration. */
export interface StatusAftermath {
  /** Only for a change to APPLIED. */
  progress?: ApplyProgress;
  /** This week's count, for the goal ring, after any change. */
  week?: WeekProgress;
  /** Badges this change earned. Plain fields: it crosses the action boundary. */
  unlocked?: UnlockedBadge[];
}

export interface UnlockedBadge {
  id: string;
  emoji: string;
  title: string;
}

/** After a status change: progress, the ring, new badges. Never a failure. */
export async function aftermathOf(status: string, justSent: JustSent): Promise<StatusAftermath> {
  // The status change itself succeeded; a missing streak is not an error.
  const out: StatusAftermath = {};
  try {
    if (status === "APPLIED") {
      out.progress = await loadApplyProgress({ justSent });
      out.week = { week: out.progress.week, goal: out.progress.goal };
    } else {
      out.week = await loadWeekProgress();
    }
  } catch {
    /* celebrate without numbers */
  }
  try {
    const fresh = await announceNewAchievements();
    if (fresh.length) out.unlocked = fresh.map(({ id, emoji, title }) => ({ id, emoji, title }));
  } catch {
    /* no badge this time */
  }
  return out;
}
