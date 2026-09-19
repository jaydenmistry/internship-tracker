import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * The tracker mutates by APPLICATION id (manual applications have no listing),
 * the table by LISTING id. Both must keep the same invariants.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("tracker mutations + read model (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let t: typeof import("@/lib/applications/tracker");
  let m: typeof import("@/lib/listings/mutations");

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    t = await import("@/lib/applications/tracker");
    m = await import("@/lib/listings/mutations");
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  async function seedListing(locations = ["Canada", "Santa Clara, CA"]) {
    const company = await prisma.company.create({ data: { name: "NVIDIA", normalizedName: "nvidia" } });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: "Software Engineering Intern",
        normalizedTitle: "software engineering intern",
        dedupKey: "nvidia|swe|x",
        url: "https://example.test/nvidia/1",
        locations,
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
  }

  const appFor = (listingId: string) => prisma.application.findUnique({ where: { listingId } });

  it("un-applying from the tracker removes a notes-less row, like the table does", async () => {
    const l = await seedListing();
    await m.setListingStatus(l.id, "APPLIED");
    const app = (await appFor(l.id))!;

    const res = await t.setApplicationStatus(app.id, "NOT_APPLIED");

    expect(res.removed).toBe(true);
    expect(await appFor(l.id)).toBeNull();
    expect(await prisma.statusEvent.count()).toBe(0);
  });

  it("un-applying from the tracker keeps a row that has notes", async () => {
    const l = await seedListing();
    await m.setListingStatus(l.id, "APPLIED");
    const app = (await appFor(l.id))!;
    await t.setApplicationNotes(app.id, "recruiter: Dana");

    const res = await t.setApplicationStatus(app.id, "NOT_APPLIED");

    expect(res.removed).toBe(false);
    expect((await appFor(l.id))?.notes).toBe("recruiter: Dana");
  });

  it("works for a manual application with no listing", async () => {
    const manual = await prisma.application.create({
      data: { companyName: "Some Startup", roleTitle: "Platform Intern", status: "APPLIED" },
    });
    await t.setApplicationStatus(manual.id, "OA");
    expect((await prisma.application.findUnique({ where: { id: manual.id } }))?.status).toBe("OA");

    await t.setApplicationStatus(manual.id, "NOT_APPLIED");
    expect(await prisma.application.findUnique({ where: { id: manual.id } })).toBeNull();
  });

  it("clearing notes on a notes-only row removes it", async () => {
    const l = await seedListing();
    await m.setListingNotes(l.id, "maybe apply");
    const app = (await appFor(l.id))!;

    const res = await t.setApplicationNotes(app.id, "   ");

    expect(res.removed).toBe(true);
    expect(await appFor(l.id)).toBeNull();
  });

  it("keeps the ORIGINAL applied date when moving back to Applied", async () => {
    const l = await seedListing();
    const firstApplied = new Date("2026-09-01T12:00:00Z");
    await m.setListingStatus(l.id, "APPLIED", { now: firstApplied });
    const app = (await appFor(l.id))!;

    await t.setApplicationStatus(app.id, "OA", { now: new Date("2026-09-05T12:00:00Z") });
    await t.setApplicationStatus(app.id, "APPLIED", { now: new Date("2026-09-06T12:00:00Z") });

    const after = (await appFor(l.id))!;
    expect(after.status).toBe("APPLIED");
    expect(after.appliedAt?.toISOString()).toBe(firstApplied.toISOString());
  });

  it("shows a US location for a multi-country listing, matching the listings table", async () => {
    const l = await seedListing(["Canada", "Santa Clara, CA"]);
    await m.setListingStatus(l.id, "APPLIED");

    const [row] = await t.loadTrackerApplications();
    expect(row.location).toBe("Santa Clara, CA");
  });

  it("excludes notes-only rows from the tracker list", async () => {
    const l = await seedListing();
    await m.setListingNotes(l.id, "just a note");
    expect(await t.loadTrackerApplications()).toEqual([]);
  });
});
