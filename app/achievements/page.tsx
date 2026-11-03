import type { Metadata } from "next";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import { loadAchievements } from "@/lib/applications/progress";
import type { Achievement } from "@/lib/celebrate/achievements";

export const metadata: Metadata = {
  title: "Achievements · Internship Tracker",
  description: "Badges for milestones, streaks and wins along the way.",
};

// Earned from your applications as they change, so never cached.
export const dynamic = "force-dynamic";

function earnedOn(at: Date): string {
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: process.env.ALERT_TIMEZONE?.trim() || undefined,
  });
}

export default async function AchievementsPage() {
  const all = await loadAchievements();
  const earned = all.filter((a) => a.unlockedAt !== null);
  // Earned first (newest on top), then the closest to unlocking.
  const sorted = [...all].sort((a, b) => {
    if (a.unlockedAt && b.unlockedAt) return b.unlockedAt.getTime() - a.unlockedAt.getTime();
    if (a.unlockedAt) return -1;
    if (b.unlockedAt) return 1;
    const pa = a.progress ? a.progress.have / a.progress.need : 0;
    const pb = b.progress ? b.progress.have / b.progress.need : 0;
    return pb - pa;
  });
  const share = all.length ? earned.length / all.length : 0;

  return (
    <div className="flex flex-col gap-5 px-6 py-7 lg:px-10 lg:py-9">
      <PageHeader
        title="Achievements"
        description={
          <>
            Badges for the milestones along the way. They unlock as you apply and hear back; your activity is on the{" "}
            <Link href="/tracker" className="text-accent hover:underline">
              Tracker
            </Link>
            .
          </>
        }
      />

      <section aria-label="Progress" className="card flex items-center gap-4 px-4 py-3.5">
        <span aria-hidden className="text-large leading-none">
          {earned.length === all.length ? "👑" : "🏅"}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-title font-semibold text-ink">
            <span className="tabular-nums">{earned.length}</span> of {all.length} earned
          </p>
          <div
            role="progressbar"
            aria-label="Achievements earned"
            aria-valuemin={0}
            aria-valuemax={all.length}
            aria-valuenow={earned.length}
            className="mt-2 h-2 overflow-hidden rounded-full bg-raised"
          >
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        </div>
      </section>

      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {sorted.map((a) => (
          <Badge key={a.id} achievement={a} />
        ))}
      </ul>
    </div>
  );
}

function Badge({ achievement: a }: { achievement: Achievement }) {
  const earned = a.unlockedAt !== null;
  return (
    <li
      data-testid="achievement"
      data-earned={earned || undefined}
      className={`card flex items-start gap-3 px-4 py-3.5 ${earned ? "achievement-earned" : ""}`}
    >
      <span
        aria-hidden
        className={`flex size-11 shrink-0 items-center justify-center rounded-full text-[1.5rem] ${
          earned ? "bg-warn/15 ring-1 ring-warn/40" : "bg-raised opacity-50 grayscale"
        }`}
      >
        {a.emoji}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-semibold ${earned ? "text-ink" : "text-dim"}`}>
          {a.title}
          <span className="sr-only">{earned ? ", earned" : ", locked"}</span>
        </p>
        <p className="text-callout text-dim">{a.description}</p>
        {earned && a.unlockedAt ? (
          <p className="mt-1 text-subhead text-faint">Earned {earnedOn(a.unlockedAt)}</p>
        ) : a.progress ? (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised">
              <div
                className="h-full rounded-full bg-accent/70"
                style={{ width: `${Math.round((a.progress.have / a.progress.need) * 100)}%` }}
              />
            </div>
            <span className="text-subhead text-faint tabular-nums">
              {a.progress.have} / {a.progress.need}
            </span>
          </div>
        ) : (
          <p className="mt-1 text-subhead text-faint">Locked</p>
        )}
      </div>
    </li>
  );
}
