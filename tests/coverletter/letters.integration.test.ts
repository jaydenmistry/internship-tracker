import { beforeEach, describe, expect, it } from "vitest";
import type { DraftClient, DraftRequest } from "@/lib/claude/draftClient";
import { hasTestDatabase } from "../db-url";

/**
 * Cover letters end to end against a real database, with a fake drafting
 * client: what is created, what is refused, and — the invariant that matters
 * most — that a letter is never deleted as a side effect of a status change.
 */
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("cover letters (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let letters: typeof import("@/lib/coverletter/letters");
  let mutations: typeof import("@/lib/listings/mutations");
  let tracker: typeof import("@/lib/applications/tracker");

  const reply = (body: string, checks: string[] = [], greeting: string | null = null) =>
    `<greeting>${greeting ?? "none"}</greeting>\n<letter>\n${body}\n</letter>\n<checks>\n${checks.map((c) => `- ${c}`).join("\n")}\n</checks>`;
  const edits = (body: string, greeting = "", recipient = "") => ({ body, greeting, recipient });

  function fakeClient(text: string | (() => string)): DraftClient & { calls: DraftRequest[] } {
    const calls: DraftRequest[] = [];
    return {
      calls,
      async complete(req) {
        calls.push(req);
        return typeof text === "function" ? text() : text;
      },
    };
  }

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    letters = await import("@/lib/coverletter/letters");
    mutations = await import("@/lib/listings/mutations");
    tracker = await import("@/lib/applications/tracker");
    await prisma.coverLetter.deleteMany();
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
    await prisma.resume.deleteMany();
    await prisma.setting.deleteMany();
  });

  async function seedListing(postingText: string | null = "We build payment APIs in Go.") {
    const company = await prisma.company.create({ data: { name: "Stripe", normalizedName: "stripe" } });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: "Backend Intern",
        normalizedTitle: "backend intern",
        dedupKey: "stripe|backend intern|x",
        url: "https://example.test/stripe/1",
        locations: ["Seattle, WA"],
        postingText,
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
  }

  const seedResume = () =>
    prisma.resume.create({ data: { filename: "resume.pdf", text: "Jayden Mistry\nBuilt a KV store in Go.", active: true } });

  it("drafts a letter for an un-applied listing, creating a NOT_APPLIED row only after success", async () => {
    const l = await seedListing();
    await seedResume();
    const client = fakeClient(reply("Dear Hiring Team,\n\nLetter.", ["Confirm the term"]));

    const saved = await letters.generateCoverLetter({ target: { listingId: l.id }, source: "listing", postingText: null, nudge: "lead with Go" }, client);

    expect(saved.body).toBe("Dear Hiring Team,\n\nLetter.");
    expect(saved.draftBody).toBe(saved.body);
    expect(saved.checks).toEqual(["Confirm the term"]);
    expect(saved.postingText).toBeNull();
    const app = await prisma.application.findUnique({ where: { listingId: l.id } });
    expect(app?.status).toBe("NOT_APPLIED");
    expect(client.calls[0].prompt).toContain("We build payment APIs in Go.");
    expect(client.calls[0].prompt).toContain("Built a KV store in Go.");
    expect(client.calls[0].prompt).toContain("lead with Go");
  });

  it("leaves nothing behind when the draft fails", async () => {
    const l = await seedListing();
    await seedResume();
    await expect(
      letters.generateCoverLetter({ target: { listingId: l.id }, source: "listing", postingText: null, nudge: null }, fakeClient("not json")),
    ).rejects.toThrow(/usable letter/);
    expect(await prisma.application.count()).toBe(0);
    expect(await prisma.coverLetter.count()).toBe(0);
  });

  it("refuses without a description, and without a resume", async () => {
    const noText = await seedListing(null);
    await seedResume();
    await expect(
      letters.generateCoverLetter({ target: { listingId: noText.id }, source: "listing", postingText: null, nudge: null }, fakeClient(reply("x"))),
    ).rejects.toThrow(/Paste the description/);

    await prisma.resume.deleteMany();
    await expect(
      letters.generateCoverLetter({ target: { listingId: noText.id }, source: "pasted", postingText: "Pasted JD", nudge: null }, fakeClient(reply("x"))),
    ).rejects.toThrow(/Upload your resume/);
  });

  it("uses and keeps a pasted description, and switching back to the fetched posting really switches", async () => {
    const l = await seedListing(null);
    await seedResume();
    const first = fakeClient(reply("One"));
    const saved = await letters.generateCoverLetter(
      { target: { listingId: l.id }, source: "pasted", postingText: "Pasted JD text", nudge: null },
      first,
    );
    expect(saved.postingText).toBe("Pasted JD text");
    expect(first.calls[0].prompt).toContain("Pasted JD text");

    // Later the worker fetches the real posting; the user picks it.
    await prisma.listing.update({ where: { id: l.id }, data: { postingText: "The real fetched posting." } });
    const second = fakeClient(reply("Two"));
    const again = await letters.generateCoverLetter(
      { target: { listingId: l.id }, source: "listing", postingText: null, nudge: null },
      second,
    );
    expect(second.calls[0].prompt).toContain("The real fetched posting.");
    expect(second.calls[0].prompt).not.toContain("Pasted JD text");
    expect(again.postingText).toBeNull();
  });

  it("survives the listing being applied to while the draft is written", async () => {
    const l = await seedListing();
    await seedResume();
    const client = fakeClient(() => "");
    client.complete = async (req) => {
      client.calls.push(req);
      await mutations.setListingStatus(l.id, "APPLIED"); // another tab, mid-draft
      return reply("Letter");
    };
    const saved = await letters.generateCoverLetter({ target: { listingId: l.id }, source: "listing", postingText: null, nudge: null }, client);
    expect(saved.body).toBe("Letter");
    expect((await prisma.application.findUnique({ where: { listingId: l.id } }))?.status).toBe("APPLIED");
  });

  it("takes Claude's greeting only when it gives one, and keeps yours otherwise", async () => {
    const l = await seedListing();
    await seedResume();
    await letters.saveCoverLetter({ listingId: l.id }, edits("Body", "Dear Recruiting,", "Recruiting\nStripe"));
    const kept = await letters.generateCoverLetter(
      { target: { listingId: l.id }, source: "listing", postingText: null, nudge: null },
      fakeClient(reply("New body")),
    );
    expect(kept.greeting).toBe("Dear Recruiting,");
    expect(kept.recipient).toBe("Recruiting\nStripe");
    const named = await letters.generateCoverLetter(
      { target: { listingId: l.id }, source: "listing", postingText: null, nudge: null },
      fakeClient(reply("New body", [], "Dear Ms. Rivera,")),
    );
    expect(named.greeting).toBe("Dear Ms. Rivera,");
  });

  it("works for a manual application with no listing", async () => {
    await seedResume();
    const app = await prisma.application.create({
      data: { status: "APPLIED", companyName: "Acme", roleTitle: "SWE Intern", events: { create: { toStatus: "APPLIED" } } },
    });
    const client = fakeClient(reply("Acme letter"));
    const saved = await letters.generateCoverLetter({ target: { applicationId: app.id }, source: "pasted", postingText: "Acme JD", nudge: null }, client);
    expect(saved.body).toBe("Acme letter");
    expect(client.calls[0].prompt).toContain("Company: Acme");
    const page = await letters.loadCoverLetterPage({ applicationId: app.id });
    expect(page?.letter?.body).toBe("Acme letter");
    expect(page?.listingId).toBeNull();
  });

  it("learns from your edits to OTHER letters, not this one", async () => {
    await seedResume();
    const other = await prisma.application.create({
      data: {
        status: "APPLIED",
        companyName: "Other",
        roleTitle: "Intern",
        coverLetter: { create: { body: "My edited voice letter", draftBody: "Claude original", checks: [] } },
      },
    });
    void other;
    const l = await seedListing();
    const client = fakeClient(reply("New"));
    await letters.generateCoverLetter({ target: { listingId: l.id }, source: "listing", postingText: null, nudge: null }, client);
    expect(client.calls[0].prompt).toContain("<voice_examples>");
    expect(client.calls[0].prompt).toContain("My edited voice letter");
  });

  it("saves edits, and can write a letter from scratch", async () => {
    const l = await seedListing();
    const saved = await letters.saveCoverLetter({ listingId: l.id }, edits("Hand-written letter", "  ", " To\n\n Stripe "));
    expect(saved.body).toBe("Hand-written letter");
    expect(saved.draftBody).toBeNull();
    expect(saved.greeting).toBeNull(); // blank means "profile default"
    expect(saved.recipient).toBe("To\nStripe");
    await expect(letters.saveCoverLetter({ listingId: l.id }, edits("   "))).rejects.toThrow(/empty/);
  });

  describe("a letter is user content: it keeps its application row", () => {
    async function withLetter() {
      const l = await seedListing();
      await letters.saveCoverLetter({ listingId: l.id }, edits("Keep me"));
      return l;
    }

    it("survives un-applying a listing", async () => {
      const l = await withLetter();
      await mutations.setListingStatus(l.id, "APPLIED");
      const res = await mutations.setListingStatus(l.id, "NOT_APPLIED");
      expect(res.status).toBe("NOT_APPLIED");
      expect(await prisma.coverLetter.count()).toBe(1);
    });

    it("survives clearing the notes", async () => {
      const l = await withLetter();
      await mutations.setListingNotes(l.id, "a note");
      await mutations.setListingNotes(l.id, "");
      expect(await prisma.coverLetter.count()).toBe(1);
    });

    it("survives a tracker status change to not applied, and clearing notes there", async () => {
      const l = await withLetter();
      const app = await prisma.application.findUniqueOrThrow({ where: { listingId: l.id } });
      expect((await tracker.setApplicationStatus(app.id, "NOT_APPLIED")).removed).toBe(false);
      expect((await tracker.setApplicationNotes(app.id, "")).removed).toBe(false);
      expect(await prisma.coverLetter.count()).toBe(1);
    });

    it("survives a CSV import row saying not applied", async () => {
      const l = await withLetter();
      const { commitImport } = await import("@/lib/applications/commit");
      await commitImport([
        {
          row: { lineNumber: 2, company: "Stripe", role: "Backend Intern", status: "NOT_APPLIED", raw: "" },
          listingId: l.id,
          status: "NOT_APPLIED",
        },
      ]);
      expect(await prisma.coverLetter.count()).toBe(1);
      expect(await prisma.application.count()).toBe(1);
    });

    it("the locked drop re-checks content and status itself", async () => {
      const { dropApplicationIfEmpty } = await import("@/lib/applications/keep");
      const l = await withLetter();
      const app = await prisma.application.findUniqueOrThrow({ where: { listingId: l.id } });
      // Called directly, past any caller's pre-check: the letter still keeps the row.
      expect(await dropApplicationIfEmpty(app.id)).toBe(false);
      expect(await dropApplicationIfEmpty(app.id, { ignoreNotes: true })).toBe(false);

      await prisma.coverLetter.deleteMany();
      await prisma.application.update({ where: { id: app.id }, data: { status: "APPLIED" } });
      // Moved to APPLIED meanwhile: a notes-clearing drop must not take it.
      expect(await dropApplicationIfEmpty(app.id, { requireStatus: "NOT_APPLIED" })).toBe(false);
      expect(await prisma.application.count()).toBe(1);

      expect(await dropApplicationIfEmpty(app.id)).toBe(true);
      expect(await prisma.application.count()).toBe(0);
    });

    it("deleting the letter drops a NOT_APPLIED row that holds nothing else", async () => {
      const l = await withLetter();
      await letters.deleteCoverLetter({ listingId: l.id });
      expect(await prisma.coverLetter.count()).toBe(0);
      expect(await prisma.application.count()).toBe(0);
    });

    it("deleting the letter keeps a row that still has notes or a real status", async () => {
      const l = await withLetter();
      await mutations.setListingNotes(l.id, "still here");
      await letters.deleteCoverLetter({ listingId: l.id });
      expect(await prisma.application.count()).toBe(1);

      const l2 = await prisma.listing.create({
        data: {
          companyId: l.companyId,
          title: "Infra Intern",
          normalizedTitle: "infra intern",
          dedupKey: "stripe|infra intern|x",
          url: "https://example.test/stripe/2",
          locations: [],
          firstSeen: new Date(),
          lastSeen: new Date(),
        },
      });
      await mutations.setListingStatus(l2.id, "APPLIED");
      await letters.saveCoverLetter({ listingId: l2.id }, edits("x"));
      await letters.deleteCoverLetter({ listingId: l2.id });
      expect((await prisma.application.findUnique({ where: { listingId: l2.id } }))?.status).toBe("APPLIED");
    });
  });

  it("shows on the tracker and in the listing detail", async () => {
    const l = await seedListing();
    await mutations.setListingStatus(l.id, "APPLIED");
    await letters.saveCoverLetter({ listingId: l.id }, edits("Three short words"));
    const [card] = await tracker.loadTrackerApplications();
    expect(card.hasCoverLetter).toBe(true);
    const { loadListingDetail } = await import("@/lib/listings/detail");
    const detail = await loadListingDetail(l.id);
    expect(detail?.application?.coverLetter?.words).toBe(3);
  });
});
