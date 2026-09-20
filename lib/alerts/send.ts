import { prisma } from "@/lib/db";
import { buildAlerts, dedupeKey } from "./build";
import { createDiscordChannel } from "./channels/discord";
import { createEmailChannel } from "./channels/email";
import { loadAlertSettings } from "./config";
import { loadAlertCandidates } from "./data";
import type { AlertSettings } from "./settings";
import type {
  AlertChannel,
  AlertChannelSender,
  AlertKind,
  AlertListing,
  BuiltAlert,
  ChannelResolution,
  ChannelUnavailable,
} from "./types";

/**
 * Orchestration: build → drop what AlertLog already covers → send → record.
 *
 * The ordering is the whole point of this module. AlertLog is written ONLY
 * after the channel reports success. Recording first would mean a send that
 * failed is deduped away on the next run and that alert is lost forever, which
 * is the one failure mode that is invisible from the outside.
 *
 * The second invariant: one channel failing never stops the other, and never
 * throws out of here. Failures are collected and returned so the worker can log
 * them and the UI can show them.
 */

export interface ChannelFailure {
  channel: AlertChannel;
  dedupeKey: string;
  subject: string;
  error: string;
}

export interface SendAlertsResult {
  kind: AlertKind;
  /** Alerts the builder produced, before dedupe. */
  built: number;
  /** Deliveries (alert × channel) that succeeded. */
  sent: number;
  /** Deliveries skipped because AlertLog already had them. */
  alreadySent: number;
  /** Alerts held back by `maxAlertsPerRun`; they go out on the next run. */
  capped: number;
  failures: ChannelFailure[];
  /** Channels that were off or unconfigured, with the reason. */
  unavailable: ChannelUnavailable[];
}

export interface SendAlertsOptions {
  now?: Date;
  /** Overrides the Setting row (tests, and the manual-trigger preview). */
  settings?: AlertSettings;
  /** Overrides the database query (pure-ish tests). */
  listings?: AlertListing[];
  /** Injected transports. When given, the environment is not consulted. */
  channels?: AlertChannelSender[];
  timeZone?: string;
  log?: (message: string) => void;
}

/**
 * Which channels would send right now, and why the others would not. Env-only,
 * no network and no secrets in the output — the /alerts page renders this.
 */
export function channelAvailability(
  settings: AlertSettings,
): Array<{ channel: AlertChannel; ready: boolean; reason: string }> {
  const discord = createDiscordChannel();
  const email = createEmailChannel();
  return [
    {
      channel: "DISCORD",
      ready: settings.discordEnabled && discord.ok,
      reason: !settings.discordEnabled
        ? "turned off in settings"
        : discord.ok
          ? "ready"
          : discord.reason,
    },
    {
      channel: "EMAIL",
      ready: settings.emailEnabled && email.ok,
      reason: !settings.emailEnabled ? "turned off in settings" : email.ok ? "ready" : email.reason,
    },
  ];
}

function resolveChannels(settings: AlertSettings): {
  senders: AlertChannelSender[];
  unavailable: ChannelUnavailable[];
} {
  const senders: AlertChannelSender[] = [];
  const unavailable: ChannelUnavailable[] = [];

  const add = (
    channel: AlertChannel,
    enabled: boolean,
    resolution: ChannelResolution,
  ) => {
    if (!enabled) {
      unavailable.push({ channel, reason: "turned off in settings" });
      return;
    }
    if (!resolution.ok) {
      // Not configured is "disabled", not a crash: the user may want only one.
      unavailable.push({ channel, reason: resolution.reason });
      return;
    }
    senders.push(resolution.sender);
  };

  add("DISCORD", settings.discordEnabled, createDiscordChannel());
  add("EMAIL", settings.emailEnabled, createEmailChannel());

  return { senders, unavailable };
}

/**
 * Send every alert of `kind` that has not been sent before.
 *
 * Never throws for a delivery problem — the worker calls this from a cron tick
 * and from the tail of a cycle, and neither may die because SMTP was down.
 */
export async function sendAlerts(
  kind: AlertKind,
  opts: SendAlertsOptions = {},
): Promise<SendAlertsResult> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m: string) => console.log(m));
  const settings = opts.settings ?? (await loadAlertSettings());

  const { senders, unavailable } = opts.channels
    ? { senders: opts.channels, unavailable: [] as ChannelUnavailable[] }
    : resolveChannels(settings);

  const listings = opts.listings ?? (await loadAlertCandidates(kind, settings, now));
  const alerts = buildAlerts(kind, listings, settings, { now, timeZone: opts.timeZone });

  const result: SendAlertsResult = {
    kind,
    built: alerts.length,
    sent: 0,
    alreadySent: 0,
    capped: 0,
    failures: [],
    unavailable,
  };

  if (alerts.length === 0 || senders.length === 0) return result;

  // One query for every (alert, channel) pair this run could produce.
  const keys = alerts.flatMap((a) => senders.map((s) => dedupeKey(a.kind, a.baseKey, s.channel)));
  const existing = new Set(
    (
      await prisma.alertLog.findMany({
        where: { dedupeKey: { in: keys } },
        select: { dedupeKey: true },
      })
    ).map((r) => r.dedupeKey),
  );

  // Dedupe BEFORE the cap. Capping first would pick the same already-sent top N
  // on every run and nothing below it would ever go out.
  const pending: Array<{ alert: BuiltAlert; senders: AlertChannelSender[] }> = [];
  for (const alert of alerts) {
    const need = senders.filter((s) => !existing.has(dedupeKey(alert.kind, alert.baseKey, s.channel)));
    result.alreadySent += senders.length - need.length;
    if (need.length > 0) pending.push({ alert, senders: need });
  }

  const limited = pending.slice(0, settings.maxAlertsPerRun);
  result.capped = pending.length - limited.length;

  for (const { alert, senders: targets } of limited) {
    for (const sender of targets) {
      const key = dedupeKey(alert.kind, alert.baseKey, sender.channel);
      try {
        await sender.send(alert);
      } catch (err) {
        // Nothing is recorded, so the next run retries this exact alert.
        result.failures.push({
          channel: sender.channel,
          dedupeKey: key,
          subject: alert.subject,
          error: err instanceof Error ? err.message : String(err),
        });
        continue; // The other channel still gets its copy.
      }

      result.sent += 1;
      try {
        await prisma.alertLog.create({
          data: {
            kind: alert.kind,
            channel: sender.channel,
            listingId: alert.listingId,
            dedupeKey: key,
          },
        });
      } catch (err) {
        // Delivered but not recorded: the opposite failure, and it can only
        // cause a duplicate, never a lost alert. Report it rather than swallow.
        result.failures.push({
          channel: sender.channel,
          dedupeKey: key,
          subject: alert.subject,
          error: `sent, but recording it failed (it may send again): ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      }
    }
  }

  log(`[alerts] ${summarize(result)}`);
  return result;
}

/** One line, safe to log and to show in the UI. Never names a credential. */
export function summarize(result: SendAlertsResult): string {
  const parts = [`${result.kind}: ${result.sent} sent`];
  if (result.built === 0) parts.push("nothing matched the thresholds");
  if (result.alreadySent > 0) parts.push(`${result.alreadySent} already sent (deduped)`);
  if (result.capped > 0) parts.push(`${result.capped} held for the next run`);
  for (const u of result.unavailable) parts.push(`${u.channel} skipped (${u.reason})`);
  for (const f of result.failures) parts.push(`${f.channel} FAILED: ${f.error}`);
  return parts.join(" · ");
}
