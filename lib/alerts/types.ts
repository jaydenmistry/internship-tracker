import type { AlertChannel, AlertKind } from "@/generated/prisma/enums";

/**
 * Shared shapes for the alerts package.
 *
 * Deliberately Prisma-free: `lib/alerts/build.ts` is pure and must stay
 * importable from a test (and, in principle, from the client) without dragging
 * in the database client. `@/generated/prisma/enums` is a plain const object —
 * no connection, no adapter — so importing the enums here is safe.
 */

export type { AlertChannel, AlertKind };

export const ALERT_KINDS = ["DAILY_DIGEST", "HIGH_SCORE", "CLOSING_SOON"] as const;
export const ALERT_CHANNELS = ["DISCORD", "EMAIL"] as const;

/**
 * The listing fields an alert can talk about. This is the boundary between the
 * database and the pure builder: `lib/alerts/data.ts` produces these, and
 * `build.ts` may look at nothing else.
 */
export interface AlertListing {
  id: string;
  company: string;
  title: string;
  /** Already collapsed to one display string by `primaryLocation`. */
  location: string;
  url: string;
  /** `finalScore`; null when the listing has never been scored. */
  score: number | null;
  deadline: Date | null;
  firstSeen: Date;
  saved: boolean;
  dismissed: boolean;
  disqualified: boolean;
  likelyClosed: boolean;
  /**
   * An Application row exists with a status other than NOT_APPLIED. A
   * NOT_APPLIED row holds notes written before applying (see
   * lib/applications/tracker.ts) and does NOT count as applied.
   */
  applied: boolean;
}

/**
 * One alert, fully rendered, before it is addressed to a channel.
 *
 * `baseKey` is channel-independent on purpose: AlertLog carries the channel, so
 * the same alert going to Discord and email is two rows with two dedupe keys
 * (see `dedupeKey` in build.ts).
 */
export interface BuiltAlert {
  kind: AlertKind;
  baseKey: string;
  /** The listing this alert is about; null for the digest, which spans many. */
  listingId: string | null;
  /** Every listing named in the body — used for logging, not for dedupe. */
  listingIds: string[];
  /** Email subject; also the one-line summary shown in the UI. */
  subject: string;
  /** Plain-text email body. */
  text: string;
  /** Discord message content (markdown, already escaped). */
  discord: string;
}

/** A configured, enabled delivery channel. `send` throws on failure. */
export interface AlertChannelSender {
  readonly channel: AlertChannel;
  send(alert: BuiltAlert): Promise<void>;
}

/**
 * Why a channel is not sending. A missing webhook or SMTP host is "disabled",
 * not an error: the user may only want one of the two.
 */
export interface ChannelUnavailable {
  channel: AlertChannel;
  reason: string;
}

export type ChannelResolution =
  | { ok: true; sender: AlertChannelSender }
  | { ok: false; reason: string };
