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
      select: {
        rank: true,
        previousRank: true,
        rankChangedAt: true,
        scoreMoved: true,
        previousScore: true,
      },
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

/**
 * Whether the listing's OWN score moved, as opposed to being pushed around by
 * listings above it. The table draws its ↑/↓ indicator only when this is true:
 * on the real catalog ~88% of ranked listings carried a rank move, nearly all
 * of them cascades, and an arrow that fires on 88% of rows reports nothing.
 */
describe.skipIf(!hasDb)("scoreMoved (integration)", () => {
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

  let n = 0;
  async function seed(finalScore: number) {
    n += 1;
    const company = await prisma.company.upsert({
      where: { normalizedName: `sm ${n}` },
      create: { name: `SM ${n}`, normalizedName: `sm ${n}` },
      update: {},
    });
    return prisma.listing.create({
      data: {
        companyId: company.id,
        title: `Role ${n}`,
        normalizedTitle: `role ${n}`,
        dedupKey: `sm-${n}|role|x`,
        url: `https://example.test/sm/${n}`,
        firstSeen: new Date(2026, 0, n),
        lastSeen: new Date(),
        finalScore,
      },
    });
  }

  const read = (id: string) =>
    prisma.listing.findUniqueOrThrow({
      where: { id },
      select: { rank: true, previousRank: true, scoreMoved: true, previousScore: true },
    });

  it("rolls previousScore forward to the current score on every run", async () => {
    const a = await seed(80);
    await recomputeRanks(new Date());
    expect((await read(a.id)).previousScore).toBe(80);

    await prisma.listing.update({ where: { id: a.id }, data: { finalScore: 91 } });
    await recomputeRanks(new Date());
    expect((await read(a.id)).previousScore).toBe(91);
  });

  it("is false for a listing shoved down the table by a listing that passed it", async () => {
    const steady = await seed(80);
    const climber = await seed(60);
    await recomputeRanks(new Date());
    expect((await read(steady.id)).rank).toBe(1);

    // Only the climber's score changes; `steady` is untouched and still scores 80.
    await prisma.listing.update({ where: { id: climber.id }, data: { finalScore: 95 } });
    await recomputeRanks(new Date());

    const pushed = await read(steady.id);
    expect(pushed.rank).toBe(2); // it moved…
    expect(pushed.previousRank).toBe(1);
    expect(pushed.scoreMoved).toBe(false); // …but not under its own power

    const mover = await read(climber.id);
    expect(mover.rank).toBe(1);
    expect(mover.scoreMoved).toBe(true);
  });

  it("stays paired with the move it describes across later no-op runs", async () => {
    const a = await seed(50);
    const b = await seed(90);
    await recomputeRanks(new Date());

    await prisma.listing.update({ where: { id: a.id }, data: { finalScore: 95 } });
    await recomputeRanks(new Date());
    expect(await read(a.id)).toMatchObject({ rank: 1, previousRank: 2, scoreMoved: true });

    // Two further runs with nothing changing must not rewrite the history of
    // the last real move — same rule previousRank/rankChangedAt already follow.
    await recomputeRanks(new Date());
    await recomputeRanks(new Date());
    expect(await read(a.id)).toMatchObject({ rank: 1, previousRank: 2, scoreMoved: true });
    expect(await read(b.id)).toMatchObject({ rank: 2, previousRank: 1, scoreMoved: false });
  });

  it("does not report a move when a score changes without changing position", async () => {
    const top = await seed(90);
    const bottom = await seed(40);
    await recomputeRanks(new Date());

    // The top listing drops 5 points but is still comfortably first.
    await prisma.listing.update({ where: { id: top.id }, data: { finalScore: 85 } });
    const moved = await recomputeRanks(new Date());

    expect(moved).toBe(0);
    const after = await read(top.id);
    expect(after.rank).toBe(1);
    // No rank move, so no arrow — and the baseline still rolled forward.
    expect(after.previousScore).toBe(85);
    expect(await read(bottom.id)).toMatchObject({ rank: 2 });
  });
});
