import { beforeEach, describe, expect, it } from "vitest";
import { hasTestDatabase } from "../db-url";
import type { DraftClient, DraftRequest } from "@/lib/claude/draftClient";
import type { ContactInput } from "@/lib/networking/schema";

const hasDb = hasTestDatabase();

/** Records every prompt; answers with the queued replies in order. */
function fakeClient(...replies: string[]): DraftClient & { calls: DraftRequest[] } {
  const calls: DraftRequest[] = [];
  return {
    calls,
    async complete(req) {
      calls.push(req);
      const next = replies.shift();
      if (next === undefined) throw new Error("no more fake replies");
      return next;
    },
  };
}

describe.skipIf(!hasDb)("drafting (integration, fake client)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let contacts: typeof import("@/lib/networking/contacts");
  let msgs: typeof import("@/lib/networking/messages");
  let drafting: typeof import("@/lib/networking/drafting");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    contacts = await import("@/lib/networking/contacts");
    msgs = await import("@/lib/networking/messages");
    drafting = await import("@/lib/networking/drafting");
    await prisma.outreachMessage.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.setting.deleteMany();
    await prisma.resume.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  }, 30_000);

  const person = (over: Partial<ContactInput> = {}): ContactInput => ({
    name: "Sam Lee",
    company: "Stripe",
    title: "Senior SWE",
    kind: "ENGINEER",
    email: "sam@stripe.com",
    linkedinUrl: null,
    howMet: "UGA career fair",
    notes: "Works on payments infra",
    doNotContact: false,
    ...over,
  });

  it("builds the prompt from the contact, resume, voice notes, posting and edited past drafts", async () => {
    const { id } = await contacts.createContact(person());
    const stripe = await prisma.company.findUniqueOrThrow({ where: { normalizedName: "stripe" } });
    const listing = await prisma.listing.create({
      data: {
        companyId: stripe.id,
        title: "SWE Intern, Payments",
        normalizedTitle: "swe intern payments",
        dedupKey: "stripe|swe intern payments|x",
        url: "https://example.test/s",
        postingText: "Build payment rails in Ruby and Go.",
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    await prisma.resume.create({ data: { filename: "r.pdf", text: "Jay, UGA CS, Next.js tracker" } });
    const { DEFAULT_NETWORKING_SETTINGS } = await import("@/lib/networking/settings");
    const { saveNetworkingSettings } = await import("@/lib/networking/followups");
    await saveNetworkingSettings({ ...DEFAULT_NETWORKING_SETTINGS, voiceNotes: "No em dashes." });

    // A past cold email to someone else, edited before sending — a voice example.
    const other = await contacts.createContact(person({ name: "Ana Diaz", company: "Ramp" }));
    await msgs.logMessage(other.id, {
      direction: "OUT",
      type: "COLD",
      channel: "EMAIL",
      subject: "Hi Ana",
      body: "My edited words",
      draftBody: "Claude's words",
      sentAt: new Date("2026-09-01T12:00:00Z"),
      listingId: null,
    });

    const client = fakeClient('{"subject":"Payments at Stripe","body":"Hi Sam, …"}');
    const draft = await drafting.generateDraft({ contactId: id, type: "COLD", listingId: listing.id, nudge: "mention Go" }, client);
    expect(draft).toEqual({ subject: "Payments at Stripe", body: "Hi Sam, …", warning: null });

    const { prompt } = client.calls[0];
    expect(prompt).toContain("Jay, UGA CS, Next.js tracker");
    expect(prompt).toContain("No em dashes.");
    expect(prompt).toContain("My edited words");
    expect(prompt).not.toContain("Claude's words");
    expect(prompt).toContain("Role: SWE Intern, Payments at Stripe");
    expect(prompt).toContain("Build payment rails in Ruby and Go.");
    expect(prompt).toContain("Works on payments infra");
    expect(prompt).toContain("Something I want it to do: mention Go");
    // Nothing is saved by drafting.
    expect(await prisma.outreachMessage.count({ where: { contactId: id } })).toBe(0);
  }, 30_000);

  it("refuses a do-not-contact contact without calling Claude", async () => {
    const { id } = await contacts.createContact(person({ doNotContact: true }));
    const client = fakeClient("unused");
    await expect(drafting.generateDraft({ contactId: id, type: "COLD", listingId: null, nudge: null }, client)).rejects.toThrow(
      /do-not-contact/,
    );
    expect(client.calls).toHaveLength(0);
  });

  it("refuses a listing at another company", async () => {
    const { id } = await contacts.createContact(person());
    const ramp = await prisma.company.create({ data: { name: "Ramp", normalizedName: "ramp" } });
    const listing = await prisma.listing.create({
      data: {
        companyId: ramp.id,
        title: "Intern",
        normalizedTitle: "intern",
        dedupKey: "ramp|intern|x",
        url: "https://example.test/r",
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    const client = fakeClient("unused");
    await expect(
      drafting.generateDraft({ contactId: id, type: "COLD", listingId: listing.id, nudge: null }, client),
    ).rejects.toThrow(/isn't at this contact's company/);
    expect(client.calls).toHaveLength(0);
  });

  it("retries an over-long LinkedIn note once, then returns it with a warning", async () => {
    const { id } = await contacts.createContact(person());
    const long = JSON.stringify({ body: "x".repeat(320) });
    const ok = JSON.stringify({ body: "Short note" });

    const fixedOnRetry = fakeClient(long, ok);
    const good = await drafting.generateDraft({ contactId: id, type: "CONNECT_NOTE", listingId: null, nudge: null }, fixedOnRetry);
    expect(good).toEqual({ subject: null, body: "Short note", warning: null });
    expect(fixedOnRetry.calls).toHaveLength(2);
    expect(fixedOnRetry.calls[1].prompt).toMatch(/previous note was 320 characters/);

    const stillLong = fakeClient(long, long);
    const warned = await drafting.generateDraft({ contactId: id, type: "CONNECT_NOTE", listingId: null, nudge: null }, stillLong);
    expect(warned.warning).toMatch(/320 characters — over LinkedIn's 300/);
    expect(stillLong.calls).toHaveLength(2);
  });

  it("refuses a third concurrent draft, and frees the slot when one finishes", async () => {
    const { id } = await contacts.createContact(person());
    const gates: Array<() => void> = [];
    const slow: DraftClient = {
      complete: () =>
        new Promise((resolve) => gates.push(() => resolve('{"subject":"s","body":"b"}'))),
    };
    const req = { contactId: id, type: "COLD" as const, listingId: null, nudge: null };
    const a = drafting.generateDraft(req, slow);
    const b = drafting.generateDraft(req, slow);
    // Wait until both have reached the client (their DB reads come first).
    while (gates.length < 2) await new Promise((r) => setTimeout(r, 10));
    await expect(drafting.generateDraft(req, slow)).rejects.toThrow(/already being written/);
    gates.forEach((open) => open());
    await Promise.all([a, b]);
    await expect(drafting.generateDraft(req, fakeClient('{"subject":"s","body":"ok"}'))).resolves.toMatchObject({ body: "ok" });
  });

  it("reports unusable model output as BadOutput", async () => {
    const { id } = await contacts.createContact(person());
    await expect(
      drafting.generateDraft({ contactId: id, type: "COLD", listingId: null, nudge: null }, fakeClient("Dear Sam, …")),
    ).rejects.toMatchObject({ kind: "BadOutput" });
  });

  it("Mark sent stores the edited body AND the draft it came from; an inbound message never keeps one", async () => {
    const { id } = await contacts.createContact(person());
    const { messageInputSchema } = await import("@/lib/networking/schema");
    const { markSentPayload, emptyEditor } = await import("@/app/network/draft-state");
    const editor = { ...emptyEditor("COLD", "EMAIL"), subject: "Hi", body: "my edit", draftBody: "claude draft" };
    await msgs.logMessage(id, messageInputSchema.parse(markSentPayload(editor, new Date("2026-09-25T16:00:00Z"))));
    const m = await prisma.outreachMessage.findFirstOrThrow({ where: { contactId: id } });
    expect(m).toMatchObject({ body: "my edit", draftBody: "claude draft", subject: "Hi", type: "COLD" });

    await msgs.logMessage(
      id,
      messageInputSchema.parse({
        direction: "IN",
        type: "REPLY",
        channel: "EMAIL",
        body: "thanks",
        draftBody: "should be dropped",
        sentAt: "2026-09-26T16:00:00Z",
      }),
    );
    const reply = await prisma.outreachMessage.findFirstOrThrow({ where: { direction: "IN" } });
    expect(reply.draftBody).toBeNull();
  });
});
