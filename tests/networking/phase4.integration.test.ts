import { beforeEach, describe, expect, it } from "vitest";
import { hasTestDatabase } from "../db-url";
import type { ContactInput } from "@/lib/networking/schema";

const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("networking phase 4 (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let contacts: typeof import("@/lib/networking/contacts");
  let referrals: typeof import("@/lib/networking/referrals");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    contacts = await import("@/lib/networking/contacts");
    referrals = await import("@/lib/networking/referrals");
    await prisma.outreachMessage.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.contact.deleteMany();
    await prisma.setting.deleteMany();
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

  const listingAt = (companyId: string) =>
    prisma.listing.create({
      data: {
        companyId,
        title: "Intern",
        normalizedTitle: "intern",
        dedupKey: `${companyId}|intern|x`,
        url: `https://example.test/${companyId}`,
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });

  describe("referrals", () => {
    it("recording one marks the contact REFERRED and shows on the tracker; clearing keeps the status", async () => {
      const { id } = await contacts.createContact(person());
      const app = await prisma.application.create({ data: { status: "APPLIED", companyName: "Stripe", roleTitle: "SWE Intern" } });

      await referrals.setReferral(app.id, id, new Date("2026-09-30T12:00:00Z"));
      expect(await prisma.contact.findUniqueOrThrow({ where: { id } })).toMatchObject({
        manualStatus: "REFERRED",
        status: "REFERRED",
      });
      const { loadTrackerApplications } = await import("@/lib/applications/tracker");
      expect((await loadTrackerApplications())[0].referredBy).toEqual({ id, name: "Sam Lee" });
      expect((await referrals.loadContactReferrals(id)).map((r) => r.role)).toEqual(["SWE Intern"]);

      await referrals.setReferral(app.id, null);
      expect((await prisma.application.findUniqueOrThrow({ where: { id: app.id } })).referredByContactId).toBeNull();
      expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).status).toBe("REFERRED");
    }, 30_000);

    it("doesn't re-date an existing REFERRED status", async () => {
      const { id } = await contacts.createContact(person());
      const a = await prisma.application.create({ data: { status: "APPLIED", companyName: "Stripe", roleTitle: "A" } });
      const b = await prisma.application.create({ data: { status: "APPLIED", companyName: "Stripe", roleTitle: "B" } });
      await referrals.setReferral(a.id, id, new Date("2026-09-01T12:00:00Z"));
      await referrals.setReferral(b.id, id, new Date("2026-09-30T12:00:00Z"));
      expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).manualStatusAt).toEqual(
        new Date("2026-09-01T12:00:00Z"),
      );
    });

    it("a second referral after a re-ask marks them REFERRED again, with nothing due", async () => {
      const { id } = await contacts.createContact(person());
      const msgs = await import("@/lib/networking/messages");
      const a = await prisma.application.create({ data: { status: "APPLIED", companyName: "Stripe", roleTitle: "A" } });
      const b = await prisma.application.create({ data: { status: "APPLIED", companyName: "Stripe", roleTitle: "B" } });
      await referrals.setReferral(a.id, id, new Date("2026-03-01T12:00:00Z"));
      // Months later: a new referral ask is an opener — it supersedes REFERRED.
      await msgs.logMessage(
        id,
        {
          direction: "OUT",
          type: "REFERRAL_ASK",
          channel: "EMAIL",
          subject: "Another role",
          body: "Would you refer me for B?",
          sentAt: new Date("2026-09-20T12:00:00Z"),
          listingId: null,
          draftBody: null,
        },
        new Date("2026-09-20T12:00:00Z"),
      );
      expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).status).toBe("AWAITING_REPLY");

      await referrals.setReferral(b.id, id, new Date("2026-09-25T12:00:00Z"));
      expect(await prisma.contact.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: "REFERRED",
        nextFollowUpAt: null,
        manualStatusAt: new Date("2026-09-25T12:00:00Z"),
      });
    }, 30_000);

    it("refuses a NOT_APPLIED notes-only row", async () => {
      const { id } = await contacts.createContact(person());
      const notes = await prisma.application.create({ data: { status: "NOT_APPLIED", companyName: "X", roleTitle: "Y", notes: "n" } });
      await expect(referrals.setReferral(notes.id, id)).rejects.toThrow(/notes-only row/);
      expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).manualStatus).toBeNull();
    });

    it("refuses unknown ids without changing anything", async () => {
      const { id } = await contacts.createContact(person());
      const app = await prisma.application.create({ data: { status: "APPLIED", companyName: "X", roleTitle: "Y" } });
      await expect(referrals.setReferral("nope", id)).rejects.toThrow(/no such application/);
      await expect(referrals.setReferral(app.id, "nope")).rejects.toThrow(/no such contact/);
      expect((await prisma.contact.findUniqueOrThrow({ where: { id } })).manualStatus).toBeNull();
    });

    it("lists only real applications (not NOT_APPLIED notes rows)", async () => {
      await prisma.application.create({ data: { status: "NOT_APPLIED", companyName: "X", roleTitle: "notes only" } });
      await prisma.application.create({ data: { status: "OA", companyName: "X", roleTitle: "real" } });
      expect((await referrals.loadReferrableApplications()).map((a) => a.role)).toEqual(["real"]);
    });
  });

  describe("bulk import", () => {
    it("creates each contact with its company, reporting failures per row", async () => {
      const { parseContactImport } = await import("@/lib/networking/import");
      const parsed = parseContactImport("Name,Company,Email\nAda,Stripe,ada@example.com\nGrace,stripe inc,\nHal,,\n");
      const result = await contacts.commitContactImport(parsed.rows.map((r) => r.contact));
      expect(result).toEqual({ created: 3, failed: [] });
      expect(await prisma.company.count()).toBe(1);
      expect(await prisma.contact.count({ where: { companyId: { not: null } } })).toBe(2);

      const existing = await contacts.loadExistingContactKeys();
      expect(existing.find((e) => e.name === "Ada")).toMatchObject({ email: "ada@example.com", companyKey: "stripe" });
    });
  });

  describe("company spelling", () => {
    it("ingestion replaces a contact-typed spelling until the company has a listing, then never", async () => {
      await contacts.createContact(person({ company: "stripe" }));
      const { upsertCompany } = await import("@/lib/ingestion/pipeline");

      const first = await upsertCompany("Stripe", false);
      expect(first.name).toBe("Stripe");
      expect((await prisma.company.findUniqueOrThrow({ where: { id: first.id } })).name).toBe("Stripe");

      await listingAt(first.id);
      const later = await upsertCompany("STRIPE, INC.", false);
      expect(later.id).toBe(first.id);
      expect((await prisma.company.findUniqueOrThrow({ where: { id: first.id } })).name).toBe("Stripe");
    }, 30_000);
  });
});
