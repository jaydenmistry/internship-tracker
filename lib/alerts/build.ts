import type { AlertChannel, AlertKind, AlertListing, BuiltAlert } from "./types";
import type { AlertSettings } from "./settings";

/**
 * Pure alert construction: listings + thresholds + "now" in, rendered messages
 * out. No database, no network, no clock of its own — every test here is a
 * plain function call.
 *
 * Everything the builder renders (company, title, location, url) is scraped
 * text, so it is escaped for Discord markdown and URLs are http(s)-guarded
 * before they ever become a link.
 */

export interface BuildOptions {
  now: Date;
  /**
   * IANA zone for calendar-date arithmetic (the digest's dedupe key, the
   * closing-soon window, the rendered deadline). Undefined means the process's
   * own zone, which in production is the worker container's — the same clock
   * the cron schedules run on.
   */
  timeZone?: string;
}

// ---------------------------------------------------------------------------
// Dedupe keys
// ---------------------------------------------------------------------------

/**
 * The AlertLog identity of one alert on one channel.
 *
 * The channel is part of the key because `AlertLog.dedupeKey` is globally
 * unique and the same alert may legitimately go to both Discord and email —
 * two deliveries, two rows, and a Discord failure must not suppress the email.
 */
export function dedupeKey(kind: AlertKind, baseKey: string, channel: AlertChannel): string {
  return `${kind}:${channel}:${baseKey}`;
}

/** Per-kind identity, channel excluded. See each builder for the rationale. */
export const baseKeys = {
  /** One digest per calendar day. */
  dailyDigest: (now: Date, timeZone?: string) => calendarDate(now, timeZone),
  /** One alert per listing, ever. */
  highScore: (listingId: string) => listingId,
  /**
   * Listing plus deadline: a deadline that MOVES is new information and should
   * legitimately re-alert, while a re-run against the same deadline must not.
   */
  closingSoon: (listingId: string, deadline: Date) => `${listingId}:${deadline.toISOString()}`,
} as const;

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------

/** `YYYY-MM-DD` in `timeZone` (default: the process zone). */
export function calendarDate(d: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Whole calendar days from `a` to `b`, negative when `b` is earlier.
 *
 * Calendar days, not 24-hour blocks: a deadline at midnight tonight is "today"
 * (0), not "in the past". Alerting on that one matters more than the tidiness
 * of comparing timestamps.
 */
export function calendarDaysBetween(a: Date, b: Date, timeZone?: string): number {
  const ms = Date.parse(calendarDate(b, timeZone)) - Date.parse(calendarDate(a, timeZone));
  return Math.round(ms / 86_400_000);
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

/** Only http(s) survives — nothing else is ever turned into a link. */
export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/**
 * Neutralizes Discord markdown in scraped text. Mentions are handled at the
 * transport (`allowed_mentions: { parse: [] }`), which is the only defense
 * that actually holds; this is about a title with an underscore not turning
 * half the message into italics.
 */
export function escapeDiscord(text: string): string {
  return text.replace(/([\\`*_~|>])/g, "\\$1");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function scoreLabel(score: number | null): string {
  return score === null ? "--" : String(score);
}

function deadlinePhrase(deadline: Date | null, o: BuildOptions): string | null {
  if (!deadline) return null;
  const days = calendarDaysBetween(o.now, deadline, o.timeZone);
  const date = calendarDate(deadline, o.timeZone);
  if (days < 0) return `closed ${date}`;
  if (days === 0) return `closes today (${date})`;
  if (days === 1) return `closes tomorrow (${date})`;
  return `closes in ${days} days (${date})`;
}

/**
 * One listing, three lines. `markdown` switches between the Discord flavour
 * (bold headline, `<url>` to suppress the embed) and the plain-text email one.
 */
function renderItem(l: AlertListing, o: BuildOptions, markdown: boolean): string {
  const head = `[${scoreLabel(l.score)}] ${collapse(l.company)} — ${collapse(l.title)}`;
  const meta = [collapse(l.location) || "location unknown", deadlinePhrase(l.deadline, o)]
    .filter(Boolean)
    .join(" · ");
  const url = safeHttpUrl(l.url);

  if (markdown) {
    return [
      `**${escapeDiscord(head)}**`,
      escapeDiscord(meta),
      url ? `<${url}>` : "_no apply link_",
    ].join("\n");
  }
  return [head, `    ${meta}`, `    ${url ?? "(no apply link)"}`].join("\n");
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Never alert on a listing the user has cleared, one the engine disqualified,
 * or one that has vanished from every source. Applied to EVERY kind — the
 * database queries filter these too, but a builder that only worked because
 * its caller filtered first is a trap for the next caller.
 */
export function isAlertable(l: AlertListing): boolean {
  return !l.dismissed && !l.disqualified && !l.likelyClosed;
}

/** Highest score first, then oldest-seen, then id — stable across runs. */
function byPriority(a: AlertListing, b: AlertListing): number {
  const as = a.score ?? -1;
  const bs = b.score ?? -1;
  if (as !== bs) return bs - as;
  const at = a.firstSeen.getTime();
  const bt = b.firstSeen.getTime();
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/**
 * Listings first seen inside the lookback window that score at or above the
 * digest minimum. Returns null when there is nothing to say — an empty digest
 * is noise, and sending one would burn the day's dedupe key.
 */
export function buildDailyDigest(
  listings: readonly AlertListing[],
  settings: AlertSettings,
  o: BuildOptions,
): BuiltAlert | null {
  const cutoff = o.now.getTime() - settings.digestLookbackHours * 3_600_000;
  const eligible = listings
    .filter(
      (l) =>
        isAlertable(l) &&
        l.score !== null &&
        l.score >= settings.digestMinScore &&
        l.firstSeen.getTime() >= cutoff,
    )
    .sort(byPriority);

  if (eligible.length === 0) return null;

  const shown = eligible.slice(0, settings.maxItemsPerDigest);
  const hidden = eligible.length - shown.length;
  const noun = eligible.length === 1 ? "role" : "roles";
  const headline =
    `${eligible.length} new ${noun} scoring ${settings.digestMinScore}+ ` +
    `(last ${settings.digestLookbackHours}h)`;
  const more = hidden > 0 ? `…and ${hidden} more in the app.` : null;

  return {
    kind: "DAILY_DIGEST",
    baseKey: baseKeys.dailyDigest(o.now, o.timeZone),
    listingId: null,
    listingIds: shown.map((l) => l.id),
    subject: `Daily digest: ${headline}`,
    text: [headline, "", ...shown.map((l) => renderItem(l, o, false)), more]
      .filter((p) => p !== null)
      .join("\n\n"),
    discord: [`**Daily digest — ${escapeDiscord(headline)}**`, ...shown.map((l) => renderItem(l, o, true)), more]
      .filter((p) => p !== null)
      .join("\n\n"),
  };
}

/** One immediate alert per listing at or above the high-score threshold. */
export function buildHighScoreAlerts(
  listings: readonly AlertListing[],
  settings: AlertSettings,
  o: BuildOptions,
): BuiltAlert[] {
  return listings
    .filter((l) => isAlertable(l) && l.score !== null && l.score >= settings.highScoreMin)
    .sort(byPriority)
    .map((l) => ({
      kind: "HIGH_SCORE" as const,
      baseKey: baseKeys.highScore(l.id),
      listingId: l.id,
      listingIds: [l.id],
      subject: `High match ${scoreLabel(l.score)}: ${collapse(l.company)} — ${collapse(l.title)}`,
      text: [`A new listing scored ${scoreLabel(l.score)}.`, "", renderItem(l, o, false)].join("\n"),
      discord: [`**High match — ${scoreLabel(l.score)}**`, renderItem(l, o, true)].join("\n"),
    }));
}

/**
 * Saved listings, plus high scorers, whose deadline lands inside the window and
 * which have no submitted application. A NOT_APPLIED row exists only to hold
 * notes, so `applied` is already false for it (see lib/alerts/data.ts).
 */
export function buildClosingSoonAlerts(
  listings: readonly AlertListing[],
  settings: AlertSettings,
  o: BuildOptions,
): BuiltAlert[] {
  return listings
    .filter((l) => {
      if (!isAlertable(l) || l.applied || l.deadline === null) return false;
      const days = calendarDaysBetween(o.now, l.deadline, o.timeZone);
      if (days < 0 || days > settings.closingSoonDays) return false;
      return l.saved || (l.score !== null && l.score >= settings.highScoreMin);
    })
    .sort((a, b) => {
      const ad = a.deadline!.getTime();
      const bd = b.deadline!.getTime();
      return ad !== bd ? ad - bd : byPriority(a, b);
    })
    .map((l) => {
      const days = calendarDaysBetween(o.now, l.deadline!, o.timeZone);
      const when = days === 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
      const why = l.saved ? "saved" : "high score";
      return {
        kind: "CLOSING_SOON" as const,
        baseKey: baseKeys.closingSoon(l.id, l.deadline!),
        listingId: l.id,
        listingIds: [l.id],
        subject: `Closing ${when}: ${collapse(l.company)} — ${collapse(l.title)}`,
        text: [
          `Deadline ${when}, and you have not applied (${why}).`,
          "",
          renderItem(l, o, false),
        ].join("\n"),
        discord: [
          `**Closing ${escapeDiscord(when)} — not applied (${why})**`,
          renderItem(l, o, true),
        ].join("\n"),
      };
    });
}

/** Dispatcher: the one entry point `send.ts` uses. */
export function buildAlerts(
  kind: AlertKind,
  listings: readonly AlertListing[],
  settings: AlertSettings,
  o: BuildOptions,
): BuiltAlert[] {
  switch (kind) {
    case "DAILY_DIGEST": {
      const digest = buildDailyDigest(listings, settings, o);
      return digest ? [digest] : [];
    }
    case "HIGH_SCORE":
      return buildHighScoreAlerts(listings, settings, o);
    case "CLOSING_SOON":
      return buildClosingSoonAlerts(listings, settings, o);
  }
}
