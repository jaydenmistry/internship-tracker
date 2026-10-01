import { beforeEach, describe, expect, it } from "vitest";
import { hasTestDatabase } from "../db-url";
import type { ContactInput } from "@/lib/networking/schema";

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("networking contacts (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let c: typeof import("@/lib/networking/contacts");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    c = await import("@/lib/networking/contacts");
    await prisma.outreachMessage.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  const input = (overrides: Partial<ContactInput> = {}): ContactInput => ({
    name: "Sam Lee",
    company: "Stripe, Inc.",
    title: "Senior SWE",
    kind: "ENGINEER",
    email: "sam@stripe.com",
    linkedinUrl: null,
    howMet: "career fair",
    notes: null,
    doNotContact: false,
    ...overrides,
  });

  async function listingAt(companyId: string, title = "Backend Intern") {
    return prisma.listing.create({
      data: {
        companyId,
        title,
        normalizedTitle: title.toLowerCase(),
        dedupKey: `x|${title}|y`,
        url: `https://example.test/${encodeURIComponent(title)}`,
        locations: ["Remote"],
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
  }

  it("creates a Company row for a company the app hasn't seen, with the ingestion normalizer", async () => {
    const { id } = await c.createContact(input());
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id }, include: { company: true } });
    expect(contact.company).toMatchObject({ name: "Stripe, Inc.", normalizedName: "stripe", faangPlus: false });
    // Derived follow-up state is untouched by a details write.
    expect(contact.status).toBe("NOT_CONTACTED");
    expect(contact.nextFollowUpAt).toBeNull();
  });

  it("reuses an existing company without renaming or re-flagging it", async () => {
    const existing = await prisma.company.create({
      data: { name: "Stripe", normalizedName: "stripe", faangPlus: true },
    });
    const { id } = await c.createContact(input({ company: "stripe inc" }));
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id } });
    expect(contact.companyId).toBe(existing.id);
    expect(await prisma.company.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({
      name: "Stripe",
      faangPlus: true,
    });
    expect(await prisma.company.count()).toBe(1);
  });

  it("a company created for a contact is the one ingestion later attaches listings to", async () => {
    const { id } = await c.createContact(input({ company: "Ramp" }));
    const { upsertCompany } = await import("@/lib/ingestion/pipeline");
    const ingested = await upsertCompany("Ramp, Inc.", false);
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id } });
    expect(ingested.id).toBe(contact.companyId);

    const listing = await listingAt(ingested.id);
    const { loadListingDetail } = await import("@/lib/listings/detail");
    const detail = await loadListingDetail(listing.id);
    expect(detail?.people.map((p) => p.name)).toEqual(["Sam Lee"]);
    // Cold-imports the ingestion pipeline and the detail read model.
  }, 30_000);

  it("leaves the company empty when none is given", async () => {
    const { id } = await c.createContact(input({ company: null }));
    expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).companyId).toBeNull();
    expect(await prisma.company.count()).toBe(0);
  });

  it("refuses a company name with nothing to match on, instead of silently dropping it", async () => {
    await expect(c.createContact(input({ company: "—" }))).rejects.toThrow(c.UnmatchableCompanyError);
    await expect(c.createContact(input({ company: "株式会社メルカリ" }))).rejects.toThrow(/English name/);
    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.company.count()).toBe(0);
  });

  it("suggests only companies with a listing or a contact", async () => {
    const { id } = await c.createContact(input({ company: "Ramp" }));
    const stripe = await prisma.company.create({ data: { name: "Stripe", normalizedName: "stripe" } });
    await listingAt(stripe.id);
    await prisma.company.create({ data: { name: "Orphan Co", normalizedName: "orphan co" } });
    expect(await c.loadCompanyNames()).toEqual(["Ramp", "Stripe"]);

    // Moving the only contact away leaves Ramp's row behind, out of the list.
    await c.updateContact(id, input({ company: "Stripe" }));
    expect(await c.loadCompanyNames()).toEqual(["Stripe"]);
  });

  it("updates details, moving the contact to another company", async () => {
    const { id } = await c.createContact(input());
    await c.updateContact(id, input({ name: "Sam Lee-Park", company: "Ramp", doNotContact: true }));
    const detail = await c.loadContact(id);
    expect(detail).toMatchObject({ name: "Sam Lee-Park", company: "Ramp", doNotContact: true });
    await expect(c.updateContact("nope", input())).rejects.toThrow(/no such contact/);
  });

  it("hard-deletes: messages cascade, a referred application stays with the referral cleared", async () => {
    const { id } = await c.createContact(input());
    await prisma.outreachMessage.create({
      data: { contactId: id, direction: "OUT", channel: "EMAIL", type: "COLD", body: "hi", sentAt: new Date() },
    });
    const app = await prisma.application.create({
      data: { status: "APPLIED", companyName: "Stripe", roleTitle: "Intern", referredByContactId: id },
    });

    await c.deleteContact(id);

    expect(await prisma.contact.count()).toBe(0);
    expect(await prisma.outreachMessage.count()).toBe(0);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).referredByContactId).toBeNull();
    await expect(c.deleteContact(id)).rejects.toThrow(/no such contact/);
  });

  it("lists people at a company, most recently in touch first", async () => {
    const quiet = await c.createContact(input({ name: "Quiet Person" }));
    const recent = await c.createContact(input({ name: "Recent Person" }));
    const older = await c.createContact(input({ name: "Older Person" }));
    const msg = (contactId: string, sentAt: string) =>
      prisma.outreachMessage.create({
        data: { contactId, direction: "OUT", channel: "EMAIL", type: "COLD", body: "hi", sentAt: new Date(sentAt) },
      });
    await msg(recent.id, "2026-09-20T12:00:00Z");
    await msg(older.id, "2026-09-01T12:00:00Z");

    const companyId = (await prisma.contact.findUniqueOrThrow({ where: { id: quiet.id } })).companyId!;
    const people = await c.loadCompanyPeople(companyId);
    expect(people.map((p) => p.name)).toEqual(["Recent Person", "Older Person", "Quiet Person"]);
    expect(people[0].lastMessageAt).toBe("2026-09-20T12:00:00.000Z");
  });

  it("tracker cards count contacts for listing-linked AND manual applications", async () => {
    await c.createContact(input({ name: "A" }));
    await c.createContact(input({ name: "B" }));
    const stripe = await prisma.company.findUniqueOrThrow({ where: { normalizedName: "stripe" } });
    const listing = await listingAt(stripe.id);
    await prisma.application.create({ data: { listingId: listing.id, status: "APPLIED" } });
    // Manual entry: only a typed company name, spelled differently.
    await prisma.application.create({ data: { status: "APPLIED", companyName: "STRIPE", roleTitle: "Other" } });
    await prisma.application.create({ data: { status: "APPLIED", companyName: "Nobody Co", roleTitle: "X" } });

    const { loadTrackerApplications } = await import("@/lib/applications/tracker");
    const apps = await loadTrackerApplications();
    const counts = Object.fromEntries(apps.map((a) => [a.role, [a.contactCount, a.contactCompanyKey]]));
    expect(counts).toEqual({ "Backend Intern": [2, "stripe"], Other: [2, "stripe"], X: [0, null] });

    // The badge's key filters /network to exactly the people it counted,
    // however the manual application spelled the company.
    const { filterContacts, EMPTY_FILTERS } = await import("@/app/network/state");
    const shown = filterContacts(await c.loadContacts(), { ...EMPTY_FILTERS, companyKey: "stripe" });
    expect(shown.map((r) => r.name).sort()).toEqual(["A", "B"]);
  }, 30_000);
});
