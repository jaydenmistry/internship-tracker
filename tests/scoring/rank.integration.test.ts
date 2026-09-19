import "dotenv/config";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Rank is persisted during the scoring run so every reader agrees on it. These
 * tests pin the two properties that make it trustworthy: it reflects score
 * order, and it only changes when a listing actually moves — which is what
 * keeps previousRank/rankChangedAt meaningful.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("rank persistence (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let recomputeRanks: (typeof import("@/lib/scoring/rescore"))["recomputeRanks"];

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    ({ recomputeRanks } = await import("@/lib/scoring/rescore"));
    await prisma.statusEvent.deleteMany();
    await prisma.application.deleteMany();
    await prisma.llmAssessment.deleteMany();
    await prisma.listingSource.deleteMany();
    await prisma.listing.deleteMany();
    await prisma.company.deleteMany();
  });

  let seq = 0;
  async function seed(score: number | null, opts: { disqualified?: boolean } = {}) {
    seq += 1;
    const name = `Co ${seq}`;
    const company = await prisma.company.upsert({
      where: { normalizedName: `co ${seq}` },
      create: { name, normalizedName: `co ${seq}` },
      update: {},
    });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: `Role ${seq}`,
        normalizedTitle: `role ${seq}`,
        dedupKey: `co-${seq}|role|x`,
        url: `https://example.test/${seq}`,
        firstSeen: new Date(2026, 0, seq),
        lastSeen: new Date(),
        finalScore: score,
        disqualified: opts.disqualified ?? false,
      },
    });
  }

  const rankOf = async (id: string) =>
    prisma.listing.findUniqueOrThrow({
      where: { id },
      select: { rank: true, previousRank: true, rankChangedAt: true },
    });

  it("assigns positions 1..N in descending score order", async () => {
    const low = await seed(40);
    const high = await seed(90);
    const mid = await seed(65);

    const moved = await recomputeRanks(new Date());

    expect(moved).toBe(3);
    expect((await rankOf(high.id)).rank).toBe(1);
    expect((await rankOf(mid.id)).rank).toBe(2);
    expect((await rankOf(low.id)).rank).toBe(3);
  });

  it("leaves disqualified listings unranked but remembers where they were", async () => {
    const good = await seed(90);
    const bad = await seed(80);
    await recomputeRanks(new Date());
    expect((await rankOf(bad.id)).rank).toBe(2);

    // The listing is disqualified later (e.g. the posting closed).
    await prisma.listing.update({ where: { id: bad.id }, data: { disqualified: true } });
    await recomputeRanks(new Date());

    const after = await rankOf(bad.id);
    expect(after.rank).toBeNull();
    expect(after.previousRank).toBe(2); // so the detail panel can say what it fell from
    expect((await rankOf(good.id)).rank).toBe(1);
  });

  it("moves nobody when nothing changed, and does not touch rankChangedAt", async () => {
    const a = await seed(90);
    await seed(50);
    const firstRun = new Date("2026-09-19T10:00:00Z");
    await recomputeRanks(firstRun);
    const before = await rankOf(a.id);

    const secondRun = new Date("2026-09-20T10:00:00Z");
    const moved = await recomputeRanks(secondRun);

    expect(moved).toBe(0);
    const after = await rankOf(a.id);
    expect(after.rank).toBe(before.rank);
    // "moved yesterday" must stay true through later no-op runs.
    expect(after.rankChangedAt?.toISOString()).toBe(before.rankChangedAt?.toISOString());
  });

  it("records the previous position and the time when a listing actually moves", async () => {
    const climber = await seed(40);
    const leader = await seed(90);
    const firstRun = new Date("2026-09-19T10:00:00Z");
    await recomputeRanks(firstRun);
    expect((await rankOf(climber.id)).rank).toBe(2);

    // The climber gains posting text and overtakes.
    await prisma.listing.update({ where: { id: climber.id }, data: { finalScore: 99 } });
    const secondRun = new Date("2026-09-20T10:00:00Z");
    const moved = await recomputeRanks(secondRun);

    expect(moved).toBe(2); // both swapped
    const after = await rankOf(climber.id);
    expect(after.rank).toBe(1);
    expect(after.previousRank).toBe(2);
    expect(after.rankChangedAt?.toISOString()).toBe(secondRun.toISOString());
    expect((await rankOf(leader.id)).rank).toBe(2);
  });

  it("puts listings with no score at the end rather than the front", async () => {
    const unscored = await seed(null);
    const scored = await seed(10);
    await recomputeRanks(new Date());

    expect((await rankOf(scored.id)).rank).toBe(1);
    expect((await rankOf(unscored.id)).rank).toBe(2);
  });

  it("is deterministic for equal scores, so ties do not churn every run", async () => {
    const a = await seed(70);
    const b = await seed(70);
    await recomputeRanks(new Date("2026-09-19T10:00:00Z"));
    const firstA = (await rankOf(a.id)).rank;
    const firstB = (await rankOf(b.id)).rank;

    const moved = await recomputeRanks(new Date("2026-09-20T10:00:00Z"));
    expect(moved).toBe(0);
    expect((await rankOf(a.id)).rank).toBe(firstA);
    expect((await rankOf(b.id)).rank).toBe(firstB);
  });
});
