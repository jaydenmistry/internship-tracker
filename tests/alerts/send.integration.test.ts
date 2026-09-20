import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import type { AlertChannel, AlertChannelSender, BuiltAlert } from "@/lib/alerts/types";
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from "@/lib/alerts/settings";

/**
 * The AlertLog path, against a real database.
 *
 * The invariant under test is the ordering in lib/alerts/send.ts: AlertLog is
 * written only AFTER the channel accepts the message. Recording first would
 * dedupe a failed send away forever, and nothing outside this test would ever
 * show that it happened.
 *
 * Transports are injected, so no message is ever delivered anywhere.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

const NOW = new Date("2026-09-20T12:00:00Z");
const TZ = "UTC";

/** A transport that records what it was handed, and fails on demand. */
function fakeChannel(channel: AlertChannel) {
  const state = { failing: false, sent: [] as BuiltAlert[] };
  const sender: AlertChannelSender = {
    channel,
    async send(alert) {
      if (state.failing) throw new Error(`${channel} transport is down`);
      state.sent.push(alert);
    },
  };
  return { sender, state };
}

function settings(overrides: Partial<AlertSettings> = {}): AlertSettings {
  return { ...DEFAULT_ALERT_SETTINGS, ...overrides };
}

describe.skipIf(!hasDb)("alert sending + AlertLog (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let send: typeof import("@/lib/alerts/send");
  let config: typeof import("@/lib/alerts/config");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    send = await import("@/lib/alerts/send");
    config = await import("@/lib/alerts/config");
    await prisma.alertLog.deleteMany();
    await prisma.setting.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  async function seedListing(
    overrides: {
      name?: string;
      score?: number;
      saved?: boolean;
      deadline?: Date | null;
      firstSeen?: Date;
      dismissed?: boolean;
    } = {},
  ) {
    const name = overrides.name ?? `Acme ${Math.random().toString(36).slice(2, 8)}`;
    const company = await prisma.company.create({
      data: { name, normalizedName: name.toLowerCase() },
    });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: "Software Engineering Intern",
        normalizedTitle: "software engineering intern",
        dedupKey: `${name.toLowerCase()}|swe|atl`,
        url: `https://jobs.example.test/${company.id}`,
        locations: ["Atlanta, GA"],
        firstSeen: overrides.firstSeen ?? new Date("2026-09-20T06:00:00Z"),
        lastSeen: NOW,
        finalScore: overrides.score ?? 90,
        saved: overrides.saved ?? false,
        dismissed: overrides.dismissed ?? false,
        deadline: overrides.deadline ?? null,
      },
    });
  }

  const run = (kind: Parameters<typeof send.sendAlerts>[0], channels: AlertChannelSender[], s = settings()) =>
    send.sendAlerts(kind, { now: NOW, timeZone: TZ, settings: s, channels, log: () => {} });

  it("records one AlertLog row per channel, only after the send succeeds", async () => {
    const listing = await seedListing({ score: 95 });
    const discord = fakeChannel("DISCORD");
    const email = fakeChannel("EMAIL");

    const result = await run("HIGH_SCORE", [discord.sender, email.sender]);

    expect(result.sent).toBe(2);
    expect(result.failures).toEqual([]);
    expect(discord.state.sent).toHaveLength(1);
    expect(email.state.sent).toHaveLength(1);

    const rows = await prisma.alertLog.findMany({ orderBy: { channel: "asc" } });
    expect(rows.map((r) => r.channel)).toEqual(["DISCORD", "EMAIL"]);
    expect(rows.every((r) => r.listingId === listing.id)).toBe(true);
    expect(rows.map((r) => r.dedupeKey).sort()).toEqual([
      `HIGH_SCORE:DISCORD:${listing.id}`,
      `HIGH_SCORE:EMAIL:${listing.id}`,
    ]);
  });

  it("does not send the same alert twice", async () => {
    await seedListing({ score: 95 });
    const discord = fakeChannel("DISCORD");

    const first = await run("HIGH_SCORE", [discord.sender]);
    const second = await run("HIGH_SCORE", [discord.sender]);

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(second.alreadySent).toBe(1);
    expect(discord.state.sent).toHaveLength(1);
    expect(await prisma.alertLog.count()).toBe(1);
  });

  it("records NOTHING when the send throws, so the alert is retried, not lost", async () => {
    await seedListing({ score: 95 });
    const discord = fakeChannel("DISCORD");
    discord.state.failing = true;

    const failed = await run("HIGH_SCORE", [discord.sender]);

    expect(failed.sent).toBe(0);
    expect(failed.failures).toHaveLength(1);
    expect(failed.failures[0].error).toContain("transport is down");
    // The critical assertion: a failed send left no dedupe row behind.
    expect(await prisma.alertLog.count()).toBe(0);

    // …and the next run therefore delivers it.
    discord.state.failing = false;
    const retried = await run("HIGH_SCORE", [discord.sender]);
    expect(retried.sent).toBe(1);
    expect(discord.state.sent).toHaveLength(1);
    expect(await prisma.alertLog.count()).toBe(1);
  });

  it("keeps sending on the other channel when one fails", async () => {
    await seedListing({ score: 95 });
    const discord = fakeChannel("DISCORD");
    const email = fakeChannel("EMAIL");
    discord.state.failing = true;

    const result = await run("HIGH_SCORE", [discord.sender, email.sender]);

    expect(result.sent).toBe(1);
    expect(result.failures.map((f) => f.channel)).toEqual(["DISCORD"]);
    expect(email.state.sent).toHaveLength(1);

    const rows = await prisma.alertLog.findMany();
    expect(rows.map((r) => r.channel)).toEqual(["EMAIL"]);

    // The Discord copy is still outstanding and goes out once it recovers.
    discord.state.failing = false;
    const retried = await run("HIGH_SCORE", [discord.sender, email.sender]);
    expect(retried.sent).toBe(1);
    expect(retried.alreadySent).toBe(1);
    expect((await prisma.alertLog.findMany()).map((r) => r.channel).sort()).toEqual([
      "DISCORD",
      "EMAIL",
    ]);
  });

  it("dedupes the digest by calendar date, not by listing", async () => {
    await seedListing({ score: 90 });
    const discord = fakeChannel("DISCORD");
    const s = settings({ digestMinScore: 70 });

    const first = await run("DAILY_DIGEST", [discord.sender], s);
    expect(first.sent).toBe(1);
    expect((await prisma.alertLog.findFirst())?.dedupeKey).toBe("DAILY_DIGEST:DISCORD:2026-09-20");

    // A new listing the same day does not earn a second digest.
    await seedListing({ score: 99 });
    const again = await run("DAILY_DIGEST", [discord.sender], s);
    expect(again.sent).toBe(0);
    expect(again.alreadySent).toBe(1);

    // The next day does — for a listing that is new within ITS lookback.
    await seedListing({ score: 91, firstSeen: new Date("2026-09-21T06:00:00Z") });
    const tomorrow = await send.sendAlerts("DAILY_DIGEST", {
      now: new Date("2026-09-21T12:00:00Z"),
      timeZone: TZ,
      settings: s,
      channels: [discord.sender],
      log: () => {},
    });
    expect(tomorrow.sent).toBe(1);
  });

  it("re-alerts closing-soon when the deadline moves", async () => {
    const listing = await seedListing({ score: 95, saved: true, deadline: new Date("2026-09-23T00:00:00Z") });
    const discord = fakeChannel("DISCORD");

    expect((await run("CLOSING_SOON", [discord.sender])).sent).toBe(1);
    expect((await run("CLOSING_SOON", [discord.sender])).sent).toBe(0);

    await prisma.listing.update({
      where: { id: listing.id },
      data: { deadline: new Date("2026-09-25T00:00:00Z") },
    });
    expect((await run("CLOSING_SOON", [discord.sender])).sent).toBe(1);
    expect(await prisma.alertLog.count()).toBe(2);
  });

  it("treats a NOT_APPLIED notes row as not applied, but a submitted one as applied", async () => {
    const notesOnly = await seedListing({ score: 95, saved: true, deadline: new Date("2026-09-22T00:00:00Z") });
    const submitted = await seedListing({ score: 95, saved: true, deadline: new Date("2026-09-22T00:00:00Z") });
    await prisma.application.create({
      data: { listingId: notesOnly.id, status: "NOT_APPLIED", notes: "ask about the team" },
    });
    await prisma.application.create({ data: { listingId: submitted.id, status: "APPLIED" } });

    const discord = fakeChannel("DISCORD");
    const result = await run("CLOSING_SOON", [discord.sender]);

    expect(result.sent).toBe(1);
    expect((await prisma.alertLog.findMany()).map((r) => r.listingId)).toEqual([notesOnly.id]);
  });

  it("excludes dismissed listings at the query level", async () => {
    await seedListing({ score: 99, dismissed: true });
    const discord = fakeChannel("DISCORD");

    const result = await run("HIGH_SCORE", [discord.sender]);

    expect(result.built).toBe(0);
    expect(result.sent).toBe(0);
    expect(await prisma.alertLog.count()).toBe(0);
  });

  it("caps a run after dedupe, and drains the rest on the next run", async () => {
    for (let i = 0; i < 3; i += 1) await seedListing({ score: 95 - i });
    const discord = fakeChannel("DISCORD");
    const s = settings({ maxAlertsPerRun: 2 });

    const first = await run("HIGH_SCORE", [discord.sender], s);
    expect(first.sent).toBe(2);
    expect(first.capped).toBe(1);

    // The cap is applied AFTER dedupe, so the third listing is next, not the
    // same top two again.
    const second = await run("HIGH_SCORE", [discord.sender], s);
    expect(second.sent).toBe(1);
    expect(second.capped).toBe(0);
    expect(await prisma.alertLog.count()).toBe(3);
  });

  it("reports an unavailable channel instead of failing", async () => {
    await seedListing({ score: 95 });
    // No channels configured at all: nothing sent, nothing recorded, no throw.
    const result = await send.sendAlerts("HIGH_SCORE", {
      now: NOW,
      settings: settings({ discordEnabled: false, emailEnabled: false }),
      log: () => {},
    });

    expect(result.sent).toBe(0);
    expect(result.unavailable.map((u) => u.channel).sort()).toEqual(["DISCORD", "EMAIL"]);
    expect(await prisma.alertLog.count()).toBe(0);
  });

  it("round-trips settings through the Setting table and survives a malformed row", async () => {
    expect(await config.loadAlertSettings()).toEqual(DEFAULT_ALERT_SETTINGS);

    await config.saveAlertSettings(settings({ highScoreMin: 77, closingSoonDays: 12 }));
    const loaded = await config.loadAlertSettings();
    expect(loaded.highScoreMin).toBe(77);
    expect(loaded.closingSoonDays).toBe(12);

    await prisma.setting.update({
      where: { key: config.ALERT_SETTINGS_KEY },
      data: { value: { highScoreMin: "banana", closingSoonDays: 5 } },
    });
    const salvaged = await config.loadAlertSettings();
    expect(salvaged.closingSoonDays).toBe(5);
    expect(salvaged.highScoreMin).toBe(DEFAULT_ALERT_SETTINGS.highScoreMin);
  });
});
