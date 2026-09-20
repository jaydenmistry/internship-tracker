import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportRow } from "@/lib/applications/import";

const hasDb = Boolean(process.env.DATABASE_URL);

function row(overrides: Partial<ImportRow> = {}): ImportRow {
  return {
    company: "Robinhood",
    role: "Software Engineer Intern - Backend",
    location: "Menlo Park, CA",
    lineNumber: 1,
    raw: "Robinhood, Software Engineer Intern - Backend, Menlo Park, CA",
    ...overrides,
  };
}

describe.skipIf(!hasDb)("application import commit (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let commitImport: (typeof import("@/lib/applications/commit"))["commitImport"];
  let recordStatus: (typeof import("@/lib/applications/commit"))["recordStatus"];
  let loadMatchableListings: (typeof import("@/lib/applications/commit"))["loadMatchableListings"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ commitImport, recordStatus, loadMatchableListings } = await import(
      "@/lib/applications/commit"
    ));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  async function seedListing(title = "Software Engineer Intern - Backend") {
    const company = await prisma.company.upsert({
      where: { normalizedName: "robinhood" },
      create: { name: "Robinhood", normalizedName: "robinhood" },
      update: {},
    });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title,
        normalizedTitle: title.toLowerCase(),
        dedupKey: `robinhood|${title.toLowerCase()}|menlo-park-ca`,
        locations: ["Menlo Park, CA"],
        url: `https://boards.greenhouse.io/robinhood/jobs/${Math.floor(Math.random() * 1e9)}`,
        requisitionId: "700001",
        firstSeen: new Date(),
        lastSeen: new Date(),
        finalScore: 75,
      },
    });
  }

  it("links a confirmed match and starts the status timeline", async () => {
    const listing = await seedListing();
    const summary = await commitImport([{ row: row(), listingId: listing.id }]);

    expect(summary).toMatchObject({ linked: 1, manual: 0, updated: 0 });
    expect(summary.failed).toEqual([]);

    const app = await prisma.application.findFirstOrThrow({ include: { events: true } });
    expect(app.listingId).toBe(listing.id);
    expect(app.status).toBe("APPLIED");
    expect(app.appliedAt).not.toBeNull();
    expect(app.events).toHaveLength(1);
    expect(app.events[0].toStatus).toBe("APPLIED");
    // Typed values are kept even when linked, so unlinking never loses them.
    expect(app.companyName).toBe("Robinhood");
    expect(app.roleTitle).toBe("Software Engineer Intern - Backend");
  });

  it("records an unmatched row as a first-class manual application", async () => {
    const summary = await commitImport([
      {
        row: row({ company: "Some Startup", role: "Platform Engineer Intern", location: "Atlanta, GA" }),
        listingId: null,
      },
    ]);

    expect(summary).toMatchObject({ linked: 0, manual: 1 });
    const app = await prisma.application.findFirstOrThrow({ include: { events: true } });
    expect(app.listingId).toBeNull();
    expect(app.companyName).toBe("Some Startup");
    expect(app.roleTitle).toBe("Platform Engineer Intern");
    expect(app.location).toBe("Atlanta, GA");
    expect(app.events).toHaveLength(1);
  });

  it("is idempotent: re-importing the same list creates no duplicates", async () => {
    const listing = await seedListing();
    await commitImport([{ row: row(), listingId: listing.id }]);
    const second = await commitImport([{ row: row(), listingId: listing.id }]);

    // Already tracked at this status: reported as unchanged, not silently
    // dropped — the counts must account for every submitted row.
    expect(second).toMatchObject({ linked: 0, updated: 0, unchanged: 1 });
    expect(await prisma.application.count()).toBe(1);
    expect(await prisma.statusEvent.count()).toBe(1);
  });

  it("does not duplicate manual applications when the same list is pasted twice", async () => {
    const manual = { row: row({ company: "Some Startup", role: "Platform Engineer Intern" }), listingId: null };
    const first = await commitImport([manual]);
    const second = await commitImport([manual]);

    expect(first.manual).toBe(1);
    expect(second).toMatchObject({ manual: 0, unchanged: 1 });
    expect(await prisma.application.count()).toBe(1);
  });

  it("matches an existing manual application despite spelling differences", async () => {
    await commitImport([
      { row: row({ company: "Some Startup", role: "Platform Engineer Intern" }), listingId: null },
    ]);
    // Legal suffix and season noise are normalized away by the same rules the
    // ingestion dedup uses.
    const second = await commitImport([
      {
        row: row({ company: "Some Startup Inc.", role: "Platform Engineer Intern (Summer 2027)" }),
        listingId: null,
      },
    ]);

    expect(second).toMatchObject({ manual: 0, unchanged: 1 });
    expect(await prisma.application.count()).toBe(1);
  });

  it("advances a manual application's status on re-import", async () => {
    const manual = { row: row({ company: "Some Startup", role: "Platform Engineer Intern" }), listingId: null };
    await commitImport([manual]);
    const second = await commitImport([{ ...manual, status: "REJECTED" as const }]);

    expect(second).toMatchObject({ manual: 0, updated: 1 });
    const app = await prisma.application.findFirstOrThrow({ include: { events: true } });
    expect(app.status).toBe("REJECTED");
    expect(app.events).toHaveLength(2);
  });

  it("advances the status when a re-import carries a later stage", async () => {
    const listing = await seedListing();
    await commitImport([{ row: row(), listingId: listing.id }]);
    const second = await commitImport([{ row: row(), listingId: listing.id, status: "INTERVIEW" }]);

    expect(second.updated).toBe(1);
    const app = await prisma.application.findFirstOrThrow({ include: { events: true } });
    expect(app.status).toBe("INTERVIEW");
    expect(app.events).toHaveLength(2);
    expect(app.events[1]).toMatchObject({ fromStatus: "APPLIED", toStatus: "INTERVIEW" });
  });

  it("does not create a notes-less NOT_APPLIED row from a CSV", async () => {
    // NOT_APPLIED exists only to hold notes; a row saying "not applied" with
    // nothing written on it records nothing.
    const listing = await seedListing();
    const summary = await commitImport([
      { row: row({ status: "NOT_APPLIED" }), listingId: listing.id },
      { row: row({ company: "Other Co", role: "Intern", status: "NOT_APPLIED" }), listingId: null },
    ]);

    expect(summary).toMatchObject({ linked: 0, manual: 0, unchanged: 2 });
    expect(await prisma.application.count()).toBe(0);
  });

  it("keeps a NOT_APPLIED row that carries notes", async () => {
    const listing = await seedListing();
    await commitImport([
      { row: row({ status: "NOT_APPLIED", notes: "referral pending" }), listingId: listing.id },
    ]);

    const app = await prisma.application.findFirstOrThrow();
    expect(app.status).toBe("NOT_APPLIED");
    expect(app.notes).toBe("referral pending");
  });

  it("removes an existing notes-less application when the CSV says not applied", async () => {
    const listing = await seedListing();
    await commitImport([{ row: row(), listingId: listing.id }]);
    expect(await prisma.application.count()).toBe(1);

    const summary = await commitImport([
      { row: row({ status: "NOT_APPLIED" }), listingId: listing.id },
    ]);

    expect(summary.updated).toBe(1);
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.statusEvent.count()).toBe(0);
  });

  it("reports a bad row instead of aborting the whole import", async () => {
    const listing = await seedListing();
    const summary = await commitImport([
      { row: row({ lineNumber: 2 }), listingId: "does-not-exist" },
      { row: row({ lineNumber: 3 }), listingId: listing.id },
    ]);

    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0].lineNumber).toBe(2);
    expect(summary.linked).toBe(1);
  });

  it("carries the requisition id and apply URL onto the application", async () => {
    const listing = await seedListing();
    await commitImport([
      {
        row: row({ requisitionId: "REQ-9", url: "https://example.test/apply/9" }),
        listingId: listing.id,
      },
    ]);
    const app = await prisma.application.findFirstOrThrow();
    expect(app.requisitionId).toBe("REQ-9");
    expect(app.applyUrl).toBe("https://example.test/apply/9");
  });

  it("recordStatus appends transitions and ignores no-op writes", async () => {
    const listing = await seedListing();
    await commitImport([{ row: row(), listingId: listing.id }]);
    const app = await prisma.application.findFirstOrThrow();

    await recordStatus(app.id, "APPLIED"); // no-op: already APPLIED
    expect(await prisma.statusEvent.count()).toBe(1);

    await recordStatus(app.id, "OA", { note: "online assessment" });
    const events = await prisma.statusEvent.findMany({ orderBy: { occurredAt: "asc" } });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ fromStatus: "APPLIED", toStatus: "OA", note: "online assessment" });
  });

  it("exposes applied state to the matcher so the UI can flag already-tracked roles", async () => {
    const listing = await seedListing();
    expect((await loadMatchableListings()).find((l) => l.id === listing.id)?.applied).toBe(false);
    await commitImport([{ row: row(), listingId: listing.id }]);
    expect((await loadMatchableListings()).find((l) => l.id === listing.id)?.applied).toBe(true);
  });
});
