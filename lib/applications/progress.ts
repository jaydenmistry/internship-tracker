import { prisma } from "@/lib/db";
import { calendarDate } from "@/lib/alerts/build";
import { milestoneFor, streakLength, type ApplyProgress } from "@/lib/celebrate/moments";

/**
 * The numbers behind an "applied" celebration: how many you've sent, how many
 * today, and the streak. Days are calendar days in ALERT_TIMEZONE, like every
 * other "today" in the app.
 *
 * Read right after the status change is written, so the new application is
 * already counted. A streak longer than the lookback window just stops
 * counting there.
 */
const STREAK_LOOKBACK_DAYS = 400;

export async function loadApplyProgress(opts: { now?: Date; timeZone?: string } = {}): Promise<ApplyProgress> {
  const now = opts.now ?? new Date();
  const timeZone = opts.timeZone ?? (process.env.ALERT_TIMEZONE?.trim() || undefined);

  const total = await prisma.application.count({
    where: { status: { notIn: ["NOT_APPLIED", "SKIPPED"] } },
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

  return {
    total,
    today: appliedToday.size,
    streak: streakLength(days, today),
    milestone: milestoneFor(total),
  };
}

/** For a Server Action: progress after a change to APPLIED, never a failure. */
export async function progressAfter(status: string): Promise<ApplyProgress | undefined> {
  if (status !== "APPLIED") return undefined;
  try {
    return await loadApplyProgress();
  } catch {
    // The status change itself succeeded; a missing streak is not an error.
    return undefined;
  }
}
