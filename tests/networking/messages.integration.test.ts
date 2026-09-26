import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import type { ContactInput, MessageInput } from "@/lib/networking/schema";

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("networking messages + follow-ups (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let contacts: typeof import("@/lib/networking/contacts");
  let msgs: typeof import("@/lib/networking/messages");
  let fu: typeof import("@/lib/networking/followups");

  // ALERT_TIMEZONE is unset in tests, so due days are computed in the process
  // zone; the assertions below compare against the same helpers.
  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    contacts = await import("@/lib/networking/contacts");
    msgs = await import("@/lib/networking/messages");
    fu = await import("@/lib/networking/followups");
    await prisma.outreachMessage.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.setting.deleteMany();
    // The digest test records a per-day AlertLog row; without this, every
    // later run is (correctly) deduped and sends nothing.
    await prisma.alertLog.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  }, 30_000);

  const person = (over: Partial<ContactInput> = {}): ContactInput => ({
    name: "Sam Lee",
    company: "Stripe",
    title: null,
    kind: "ENGINEER",
    email: null,
    linkedinUrl: null,
    howMet: null,
    notes: null,
    doNotContact: false,
    ...over,
  });
  const cold = (sentAt: string, over: Partial<MessageInput> = {}): MessageInput => ({
    direction: "OUT",
    type: "COLD",
    channel: "EMAIL",
    subject: "Hi",
    body: "Hello",
    sentAt: new Date(sentAt),
    listingId: null,
    ...over,
  });
  const stored = (id: string) =>
    prisma.contact.findUniqueOrThrow({
      where: { id },
      select: { status: true, nextFollowUpAt: true, followUpsSent: true, followUpOverrideAt: true },
    });

  it("logging an opener stores the derived state in the same transaction", async () => {
    const { id } = await contacts.createContact(person());
    const { businessDaysAfter } = await import("@/lib/networking/dates");
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z"), new Date("2026-09-25T17:00:00Z"));
    expect(await stored(id)).toMatchObject({
      status: "AWAITING_REPLY",
      nextFollowUpAt: businessDaysAfter(new Date("2026-09-25T16:00:00Z"), 5, undefined),
      followUpsSent: 0,
    });
  });

  it("uses the saved cadence, and saving a new one recomputes everyone", async () => {
    const { id } = await contacts.createContact(person());
    const { businessDaysAfter } = await import("@/lib/networking/dates");
    const sent = new Date("2026-09-25T16:00:00Z");
    await msgs.logMessage(id, cold(sent.toISOString()), sent);
    const { DEFAULT_NETWORKING_SETTINGS } = await import("@/lib/networking/settings");
    await fu.saveNetworkingSettings({ ...DEFAULT_NETWORKING_SETTINGS, firstFollowUpBusinessDays: 2 }, sent);
    expect((await stored(id)).nextFollowUpAt).toEqual(businessDaysAfter(sent, 2, undefined));
  });

  it("a failed mutation leaves neither the message nor a changed status behind", async () => {
    const { id } = await contacts.createContact(person());
    const other = await prisma.company.create({ data: { name: "Ramp", normalizedName: "ramp" } });
    const listing = await prisma.listing.create({
      data: {
        companyId: other.id,
        title: "Intern",
        normalizedTitle: "intern",
        dedupKey: "ramp|intern|x",
        url: "https://example.test/r",
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    await expect(msgs.logMessage(id, cold("2026-09-25T16:00:00Z", { listingId: listing.id }))).rejects.toThrow(
      /isn't at this contact's company/,
    );
    expect(await prisma.outreachMessage.count()).toBe(0);
    expect((await stored(id)).status).toBe("NOT_CONTACTED");
  });

  it("a reply stops the cadence; deleting it brings the reminder back", async () => {
    const { id } = await contacts.createContact(person());
    const now = new Date("2026-09-26T12:00:00Z");
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z"), now);
    await msgs.logMessage(id, cold("2026-09-26T10:00:00Z", { direction: "IN", type: "REPLY" }), now);
    expect(await stored(id)).toMatchObject({ status: "REPLIED", nextFollowUpAt: null });

    const reply = await prisma.outreachMessage.findFirstOrThrow({ where: { direction: "IN" } });
    await msgs.deleteMessage(reply.id, now);
    expect((await stored(id)).status).toBe("AWAITING_REPLY");
    expect((await stored(id)).nextFollowUpAt).not.toBeNull();
  });

  it("a reply in the same minute as the opener still counts, even after the opener is edited", async () => {
    const { id } = await contacts.createContact(person());
    const t = "2026-09-25T16:00:00Z";
    await msgs.logMessage(id, cold(t));
    await msgs.logMessage(id, cold(t, { direction: "IN", type: "REPLY" }));
    expect((await stored(id)).status).toBe("REPLIED");
    // An UPDATE moves the row in Postgres; without an ORDER BY the engine
    // could see [reply, opener] and flip back to awaiting a reply.
    const opener = await prisma.outreachMessage.findFirstOrThrow({ where: { direction: "OUT" } });
    await msgs.editMessage(opener.id, { subject: "Hi", body: "edited", sentAt: new Date(t) });
    expect((await stored(id)).status).toBe("REPLIED");
    const due = await fu.loadDueFollowUps(await fu.followUpContext(undefined, new Date("2026-10-30T12:00:00Z")));
    expect(due).toEqual([]);
  });

  it("a clock-only change (going COLD) doesn't bump updatedAt", async () => {
    const { id } = await contacts.createContact(person());
    await msgs.logMessage(id, cold("2026-08-03T16:00:00Z"), new Date("2026-08-03T17:00:00Z"));
    await msgs.logMessage(id, cold("2026-08-10T16:00:00Z", { type: "FOLLOW_UP" }), new Date("2026-08-10T17:00:00Z"));
    await msgs.logMessage(id, cold("2026-08-19T16:00:00Z", { type: "FOLLOW_UP" }), new Date("2026-08-19T17:00:00Z"));
    const before = await prisma.contact.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    await fu.recomputeTimeSensitive(await fu.followUpContext(undefined, new Date("2026-09-25T17:00:00Z")));
    const after = await prisma.contact.findUniqueOrThrow({ where: { id }, select: { updatedAt: true, status: true } });
    expect(after.status).toBe("COLD");
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("the optimistic guard the batch recompute writes through rejects a stale read", async () => {
    const { id } = await contacts.createContact(person());
    await msgs.logMessage(id, cold("2026-09-18T16:00:00Z"), new Date("2026-09-18T17:00:00Z"));
    // Simulate the race: the recompute's read is stale because a reply was
    // logged (and stored REPLIED) after it. Model it by changing the row's
    // updatedAt out from under a recompute that has already computed.
    const stale = await prisma.contact.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    await msgs.logMessage(id, cold("2026-09-19T16:00:00Z", { direction: "IN", type: "REPLY" }), new Date("2026-09-19T17:00:00Z"));
    const { count } = await prisma.contact.updateMany({
      where: { id, updatedAt: stale.updatedAt },
      data: { status: "AWAITING_REPLY" },
    });
    expect(count).toBe(0); // the optimistic guard the recompute uses
    expect((await stored(id)).status).toBe("REPLIED");
  });

  it("Log meeting: CHATTED, with a thank-you due the next business day", async () => {
    const { id } = await contacts.createContact(person());
    const { businessDaysAfter } = await import("@/lib/networking/dates");
    // Friday: the thank-you is due Monday.
    const met = new Date("2026-09-25T16:00:00Z");
    await msgs.logMessage(id, { ...cold(met.toISOString()), type: "MEETING", channel: "IN_PERSON", subject: null, body: "coffee" }, met);
    expect(await stored(id)).toMatchObject({ status: "CHATTED", nextFollowUpAt: businessDaysAfter(met, 1, undefined) });
    const due = await fu.loadDueFollowUps(await fu.followUpContext(undefined, new Date("2026-09-28T17:00:00Z")));
    expect(due.map((d) => d.kind)).toEqual(["THANK_YOU"]);

    await msgs.logMessage(id, cold("2026-09-28T18:00:00Z", { type: "THANK_YOU" }), new Date("2026-09-28T18:00:00Z"));
    expect(await stored(id)).toMatchObject({ status: "CHATTED", nextFollowUpAt: null });
  });

  it("Mark connected: back to NOT_CONTACTED, with a 'send opener' due the next business day", async () => {
    const { id } = await contacts.createContact(person());
    const { businessDaysAfter } = await import("@/lib/networking/dates");
    const linkedin = { channel: "LINKEDIN" as const, subject: null };
    await msgs.logMessage(id, cold("2026-09-20T16:00:00Z", { ...linkedin, type: "CONNECT_NOTE" }));
    expect(await stored(id)).toMatchObject({ status: "PENDING_CONNECTION", nextFollowUpAt: null });

    // Exactly the payload FollowUpBar's "Mark connected" button sends.
    const accepted = new Date("2026-09-25T16:00:00Z");
    const { messageInputSchema } = await import("@/lib/networking/schema");
    const payload = messageInputSchema.parse({
      direction: "IN",
      type: "ACCEPTED",
      channel: "LINKEDIN",
      body: "",
      sentAt: accepted.toISOString(),
    });
    await msgs.logMessage(id, payload, accepted);
    expect(await stored(id)).toMatchObject({
      status: "NOT_CONTACTED",
      nextFollowUpAt: businessDaysAfter(accepted, 1, undefined),
    });
    const due = await fu.loadDueFollowUps(await fu.followUpContext(undefined, new Date("2026-09-28T17:00:00Z")));
    expect(due.map((d) => d.kind)).toEqual(["SEND_OPENER"]);
  });

  it("editing a message's date moves the due date", async () => {
    const { id } = await contacts.createContact(person());
    const { businessDaysAfter } = await import("@/lib/networking/dates");
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z"));
    const m = await prisma.outreachMessage.findFirstOrThrow();
    await msgs.editMessage(m.id, { subject: "Hi", body: "Edited", sentAt: new Date("2026-09-28T16:00:00Z") });
    expect((await stored(id)).nextFollowUpAt).toEqual(businessDaysAfter(new Date("2026-09-28T16:00:00Z"), 5, undefined));
    expect((await prisma.outreachMessage.findUniqueOrThrow({ where: { id: m.id } })).body).toBe("Edited");
  });

  it("snooze replaces the date, and logging a message clears it", async () => {
    const { id } = await contacts.createContact(person());
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z"));
    const until = new Date("2026-10-20T04:00:00Z");
    await msgs.setSnooze(id, until);
    expect(await stored(id)).toMatchObject({ nextFollowUpAt: until, followUpOverrideAt: until });

    await msgs.logMessage(id, cold("2026-09-29T16:00:00Z", { type: "FOLLOW_UP" }));
    const after = await stored(id);
    expect(after.followUpOverrideAt).toBeNull();
    expect(after.followUpsSent).toBe(1);
    expect(after.nextFollowUpAt).not.toEqual(until);
  });

  it("marking do-not-contact through a details edit clears the date", async () => {
    const { id } = await contacts.createContact(person());
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z"));
    await contacts.updateContact(id, person({ doNotContact: true }));
    expect(await stored(id)).toMatchObject({ status: "AWAITING_REPLY", nextFollowUpAt: null });
  });

  it("a manual status holds until a newer opener", async () => {
    const { id } = await contacts.createContact(person());
    await msgs.logMessage(id, cold("2026-09-01T16:00:00Z"));
    await msgs.setManualStatus(id, "REFERRED", new Date("2026-09-02T16:00:00Z"));
    expect(await stored(id)).toMatchObject({ status: "REFERRED", nextFollowUpAt: null });
    await msgs.logMessage(id, cold("2026-09-25T16:00:00Z", { type: "REFERRAL_ASK" }), new Date("2026-09-25T17:00:00Z"));
    expect((await stored(id)).status).toBe("AWAITING_REPLY");
  });

  it("the time-based recompute moves an overdue contact to COLD and lists what's due", async () => {
    const a = await contacts.createContact(person({ name: "Gone Cold" }));
    const b = await contacts.createContact(person({ name: "Due Now" }));
    // Default cadence 5 / 7 / max 2.
    await msgs.logMessage(a.id, cold("2026-08-03T16:00:00Z"), new Date("2026-08-03T17:00:00Z"));
    await msgs.logMessage(a.id, cold("2026-08-10T16:00:00Z", { type: "FOLLOW_UP" }), new Date("2026-08-10T17:00:00Z"));
    await msgs.logMessage(a.id, cold("2026-08-19T16:00:00Z", { type: "FOLLOW_UP" }), new Date("2026-08-19T17:00:00Z"));
    await msgs.logMessage(b.id, cold("2026-09-18T16:00:00Z"), new Date("2026-09-18T17:00:00Z"));
    expect((await stored(a.id)).status).toBe("AWAITING_REPLY");

    const now = new Date("2026-09-25T17:00:00Z");
    const due = await fu.loadDueFollowUps(await fu.followUpContext(undefined, now));
    expect((await stored(a.id)).status).toBe("COLD");
    expect(due.map((d) => [d.name, d.kind, d.company])).toEqual([["Due Now", "FOLLOW_UP", "Stripe"]]);
  });

  it("the digest carries follow-ups even with no new listings", async () => {
    const { id } = await contacts.createContact(person({ name: "Due Now" }));
    await msgs.logMessage(id, cold("2026-09-18T16:00:00Z"), new Date("2026-09-18T17:00:00Z"));
    const send = await import("@/lib/alerts/send");
    const delivered: string[] = [];
    const result = await send.sendAlerts("DAILY_DIGEST", {
      now: new Date("2026-09-25T17:00:00Z"),
      listings: [],
      channels: [{ channel: "DISCORD", send: async (a) => void delivered.push(a.text) }],
      log: () => {},
    });
    expect(result.sent).toBe(1);
    expect(delivered[0]).toContain("Due Now (Stripe) — follow up");
    expect(delivered[0]).toContain(`/network/${id}`);
  }, 30_000);
});
