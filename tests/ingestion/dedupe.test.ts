import { describe, expect, it } from "vitest";
import {
  decideMerge,
  type MergeCandidate,
  type MergeInput,
} from "@/lib/ingestion/dedupe";
import { titleSimilarity } from "@/lib/ingestion/normalize";

function candidate(overrides: Partial<MergeCandidate> & { id: string }): MergeCandidate {
  return {
    url: "https://example.com/job",
    requisitionId: null,
    dedupKey: "acme|software engineer intern|atlanta-ga",
    normalizedTitle: "software engineer intern",
    ...overrides,
  };
}

function incoming(overrides: Partial<MergeInput> = {}): MergeInput {
  return {
    url: "https://example.com/job",
    requisitionId: null,
    dedupKey: "acme|software engineer intern|atlanta-ga",
    normalizedTitle: "software engineer intern",
    ...overrides,
  };
}

describe("decideMerge — hard identity guard", () => {
  it("AMD case: same host, different path → create even with identical dedupKey/title", () => {
    const d = decideMerge(
      incoming({
        url: "https://careers.amd.com/jobs/91866?icims=1",
        requisitionId: "91866",
        dedupKey: "amd|compiler engineer intern co-op|san-jose-ca",
        normalizedTitle: "compiler engineer intern co-op",
      }),
      [
        candidate({
          id: "listing-91865",
          url: "https://careers.amd.com/jobs/91865",
          requisitionId: "91865",
          dedupKey: "amd|compiler engineer intern co-op|san-jose-ca",
          normalizedTitle: "compiler engineer intern co-op",
        }),
      ],
    );
    expect(d.action).toBe("create");
    expect(d.reason).toContain("identity guard");
  });

  it("differing req ids alone (different hosts) → create", () => {
    const d = decideMerge(
      incoming({
        url: "https://boards.greenhouse.io/acme/jobs/111",
        requisitionId: "111",
      }),
      [
        candidate({
          id: "c1",
          url: "https://jobs.lever.co/acme/51378fa0-0327-45fd-9420-b6e7d8b56440",
          requisitionId: "51378fa0-0327-45fd-9420-b6e7d8b56440",
        }),
      ],
    );
    expect(d.action).toBe("create");
    expect(d.reason).toContain("differing req ids");
  });

  it("Workday req match: equal req ids merge regardless of fuzzy score or dedupKey", () => {
    const d = decideMerge(
      incoming({
        url: "https://haier.wd3.myworkdayjobs.com/ge_appliances/job/USA-Louisville-KY/Software-Engineering-Co-op-Spring-2027_REQ-24832",
        requisitionId: "REQ-24832",
        dedupKey: "ge appliances|software engineering co-op|louisville-ky",
        normalizedTitle: "software engineering co-op",
      }),
      [
        candidate({
          id: "existing-req",
          url: "https://haier.wd3.myworkdayjobs.com/careers/job/USA-Louisville-KY/Early-Career-Program_REQ-24832",
          requisitionId: "REQ-24832",
          // Wildly different title and dedupKey — identity still proven.
          dedupKey: "ge appliances|early career technology program|louisville-ky",
          normalizedTitle: "early career technology program",
        }),
      ],
    );
    expect(d).toEqual({
      action: "merge",
      targetId: "existing-req",
      reason: "req id match: REQ-24832",
    });
  });

  it("req id equality wins even when another candidate would also be in play", () => {
    const d = decideMerge(
      incoming({ requisitionId: "R123456" }),
      [
        candidate({ id: "fuzzy-only", url: "https://a.example.com/1" }),
        candidate({
          id: "proven",
          url: "https://b.example.com/2",
          requisitionId: "R123456",
          dedupKey: "acme|totally different thing|remote",
          normalizedTitle: "totally different thing",
        }),
      ],
    );
    expect(d.action).toBe("merge");
    expect(d.action === "merge" && d.targetId).toBe("proven");
  });

  it("refuses two requisitions that differ only in the query string", () => {
    // Regression, from the real catalog: three EquipmentShare postings share
    // one path and differ only in ?gh_jid=. Comparing host+path alone called
    // them the same listing and merged them, hiding two roles behind a third.
    const d = decideMerge(
      incoming({
        url: "https://www.equipmentshare.com/careers/openings/?gh_jid=8188802",
        requisitionId: null,
        dedupKey: "equipmentshare|software engineer intern|columbia-mo",
      }),
      [
        candidate({
          id: "already-stored",
          url: "https://www.equipmentshare.com/careers/openings/?gh_jid=8188474",
          requisitionId: null,
          dedupKey: "equipmentshare|software engineer intern|columbia-mo",
        }),
      ],
    );
    expect(d.action).toBe("create");
    expect(d.reason).toMatch(/identity guard/);
  });

  it("still merges when the query differs only by a tracking param", () => {
    // canonicalizeUrl strips utm_*/gh_src/ref before the comparison, so the
    // stricter rule above must not split one listing arriving with campaign
    // tags on its URL.
    const d = decideMerge(
      incoming({
        url: "https://www.equipmentshare.com/careers/openings/?gh_jid=8188474&utm_source=simplify",
        requisitionId: null,
        dedupKey: "equipmentshare|software engineer intern|columbia-mo",
      }),
      [
        candidate({
          id: "already-stored",
          url: "https://www.equipmentshare.com/careers/openings/?gh_jid=8188474&gh_src=abc",
          requisitionId: null,
          dedupKey: "equipmentshare|software engineer intern|columbia-mo",
        }),
      ],
    );
    expect(d.action).toBe("merge");
  });
});

describe("decideMerge — inconclusive identities", () => {
  it("cross-source happy path: aggregator URL + single ATS candidate, same dedupKey → merge", () => {
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/abc",
        requisitionId: null,
        dedupKey: "bmo|software developer internship|san-ramon-ca",
        normalizedTitle: "software developer internship",
      }),
      [
        candidate({
          id: "workday-row",
          url: "https://bmo.wd3.myworkdayjobs.com/External/job/San-Ramon-CA-USA/Software-Developer--Summer-2026--Internship----10-weeks_R260002319-1",
          requisitionId: "R260002319-1",
          dedupKey: "bmo|software developer internship|san-ramon-ca",
          normalizedTitle: "software developer internship",
        }),
      ],
    );
    expect(d).toMatchObject({ action: "merge", targetId: "workday-row" });
    expect(d.reason).toContain("inconclusive");
  });

  it("Robinhood case: one aggregator row vs three same-dedupKey requisitions → create (ambiguous)", () => {
    const dedupKey = "robinhood|software engineer intern|menlo-park-ca";
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/xyz",
        requisitionId: null,
        dedupKey,
        normalizedTitle: "software engineer intern",
      }),
      [1, 2, 3].map((n) =>
        candidate({
          id: `wd-${n}`,
          url: `https://robinhood.wd5.myworkdayjobs.com/careers/job/Menlo-Park-CA/Software-Engineer-Intern_R-10000${n}`,
          requisitionId: `R-10000${n}`,
          dedupKey,
          normalizedTitle: "software engineer intern",
        }),
      ),
    );
    expect(d.action).toBe("create");
    expect(d.reason).toContain("3 candidates survived guard");
    expect(d.reason).toContain("ambiguous");
  });

  it("zero candidates → create", () => {
    const d = decideMerge(incoming(), []);
    expect(d.action).toBe("create");
    expect(d.reason).toContain("no candidates in play");
  });
});

describe("decideMerge — fuzzy matching", () => {
  const engineerKey = "acme|software engineer intern|atlanta-ga";
  const engineeringKey = "acme|software engineering intern|atlanta-ga";

  it("near-miss titles merge: engineer vs engineering (no identifiers)", () => {
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/a1",
        dedupKey: engineeringKey,
        normalizedTitle: "software engineering intern",
      }),
      [
        candidate({
          id: "existing",
          url: "https://jobs.example-ats.com/acme/123",
          dedupKey: engineerKey,
          normalizedTitle: "software engineer intern",
        }),
      ],
    );
    expect(d).toMatchObject({ action: "merge", targetId: "existing" });
    expect(d.reason).toContain("fuzzy");
  });

  it("different discipline does not merge: software vs hardware", () => {
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/a2",
        dedupKey: engineerKey,
        normalizedTitle: "software engineer intern",
      }),
      [
        candidate({
          id: "hw",
          url: "https://jobs.example-ats.com/acme/456",
          dedupKey: "acme|hardware engineer intern|atlanta-ga",
          normalizedTitle: "hardware engineer intern",
        }),
      ],
    );
    expect(d.action).toBe("create");
  });

  it("respects opts.fuzzyThreshold — raising it blocks the engineering near-miss", () => {
    const args = [
      incoming({
        url: "https://jobright.ai/jobs/info/a3",
        dedupKey: engineeringKey,
        normalizedTitle: "software engineering intern",
      }),
      [
        candidate({
          id: "existing",
          url: "https://jobs.example-ats.com/acme/123",
          dedupKey: engineerKey,
          normalizedTitle: "software engineer intern",
        }),
      ],
    ] as const;
    expect(decideMerge(args[0], [...args[1]]).action).toBe("merge");
    expect(decideMerge(args[0], [...args[1]], { fuzzyThreshold: 0.95 }).action).toBe("create");
  });

  it("respects opts.fuzzyThreshold — lowering it lets weaker matches in play", () => {
    // Just below the software/hardware similarity, so the pair comes in play.
    const weakSim = titleSimilarity("software engineer intern", "hardware engineer intern");
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/a4",
        dedupKey: engineerKey,
        normalizedTitle: "software engineer intern",
      }),
      [
        candidate({
          id: "hw",
          url: "https://jobs.example-ats.com/acme/456",
          dedupKey: "acme|hardware engineer intern|atlanta-ga",
          normalizedTitle: "hardware engineer intern",
        }),
      ],
      { fuzzyThreshold: Math.max(0.05, weakSim - 0.05) },
    );
    expect(d).toMatchObject({ action: "merge", targetId: "hw" });
  });

  it("two fuzzy survivors are ambiguous → create", () => {
    const d = decideMerge(
      incoming({
        url: "https://jobright.ai/jobs/info/a5",
        dedupKey: engineeringKey,
        normalizedTitle: "software engineering intern",
      }),
      [
        candidate({
          id: "c1",
          url: "https://one.example-ats.com/1",
          dedupKey: engineerKey,
          normalizedTitle: "software engineer intern",
        }),
        candidate({
          id: "c2",
          url: "https://two.example-ats.com/2",
          dedupKey: engineeringKey,
          normalizedTitle: "software engineering intern",
        }),
      ],
    );
    expect(d.action).toBe("create");
    expect(d.reason).toContain("ambiguous");
  });

  it("every decision carries a human-readable reason", () => {
    const d = decideMerge(incoming(), [candidate({ id: "only" })]);
    expect(d.reason.length).toBeGreaterThan(0);
    expect(d).toMatchObject({ action: "merge", targetId: "only" });
    expect(d.reason).toContain("exact dedupKey match");
  });
});
