import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The invariant these guard: user-written notes are never deleted as a side
 * effect of a status change. Before this, un-applying a listing (pressing `a`
 * twice) deleted the Application row — and the notes on it — silently.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("listing mutations (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let m: typeof import("@/lib/listings/mutations");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    m = await import("@/lib/listings/mutations");
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  async function seed() {
    const company = await prisma.company.create({ data: { name: "Stripe", normalizedName: "stripe" } });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: "Backend Intern",
        normalizedTitle: "backend intern",
        dedupKey: "stripe|backend intern|x",
        url: "https://example.test/stripe/1",
        locations: ["Seattle, WA"],
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
  }

  const app = (listingId: string) =>
    prisma.application.findUnique({ where: { listingId }, include: { events: true } });

  it("un-applying a listing with no notes returns it to the canonical no-row state", async () => {
    const l = await seed();
    await m.setListingStatus(l.id, "APPLIED");
    const res = await m.setListingStatus(l.id, "NOT_APPLIED");

    expect(res.status).toBeNull();
    expect(await app(l.id)).toBeNull();
    expect(await prisma.statusEvent.count()).toBe(0);
  });

  it("un-applying a listing WITH notes keeps the row and the notes", async () => {
    const l = await seed();
    await m.setListingStatus(l.id, "APPLIED");
    await m.setListingNotes(l.id, "Referral from Sam — follow up Friday");

    const res = await m.setListingStatus(l.id, "NOT_APPLIED");

    expect(res.status).toBe("NOT_APPLIED");
    const a = await app(l.id);
    expect(a?.notes).toBe("Referral from Sam — follow up Friday");
    expect(a?.status).toBe("NOT_APPLIED");
    // The un-apply is still recorded on the timeline.
    expect(a?.events.map((e) => e.toStatus)).toEqual(expect.arrayContaining(["APPLIED", "NOT_APPLIED"]));
  });

  it("lets notes be written before applying without marking the listing applied", async () => {
    const l = await seed();
    await m.setListingNotes(l.id, "ask about return offers");

    const a = await app(l.id);
    expect(a?.status).toBe("NOT_APPLIED");
    expect(a?.appliedAt).toBeNull();
    expect(a?.notes).toBe("ask about return offers");
    // It still carries the listing's own text, so it survives an unlink.
    expect(a?.companyName).toBe("Stripe");
    expect(a?.roleTitle).toBe("Backend Intern");
  });

  it("keeps notes across a later apply", async () => {
    const l = await seed();
    await m.setListingNotes(l.id, "prep system design");
    await m.setListingStatus(l.id, "APPLIED");

    const a = await app(l.id);
    expect(a?.status).toBe("APPLIED");
    expect(a?.appliedAt).not.toBeNull();
    expect(a?.notes).toBe("prep system design");
  });

  it("drops a notes-only row once its notes are cleared", async () => {
    const l = await seed();
    await m.setListingNotes(l.id, "temp");
    await m.setListingNotes(l.id, "   ");
    expect(await app(l.id)).toBeNull();
  });

  it("clearing notes on a real application keeps the application", async () => {
    const l = await seed();
    await m.setListingStatus(l.id, "APPLIED");
    await m.setListingNotes(l.id, "x");
    await m.setListingNotes(l.id, "");

    const a = await app(l.id);
    expect(a?.status).toBe("APPLIED");
    expect(a?.notes).toBeNull();
  });

  it("writing empty notes on a listing with no row is a no-op", async () => {
    const l = await seed();
    await m.setListingNotes(l.id, "");
    expect(await app(l.id)).toBeNull();
  });
});
