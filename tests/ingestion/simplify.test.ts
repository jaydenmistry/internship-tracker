import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  extractFaangCompanies,
  simplifyAdapter,
} from "@/lib/ingestion/adapters/simplify";
import {
  NormalizedListingSchema,
  type FetchContext,
} from "@/lib/ingestion/adapters/types";

const FIXTURES = path.resolve(__dirname, "../fixtures/simplify");
const listingsFixture = readFileSync(path.join(FIXTURES, "listings.sample.json"), "utf8");
const readmeFixture = readFileSync(path.join(FIXTURES, "readme.sample.md"), "utf8");

/**
 * Hand-counted from listings.sample.json: entries whose terms include
 * "Summer 2027" AND is_visible === true (active AND inactive alike):
 * Aquatic Capital, Salesforce x2, Ellipsis Labs, Fiserv, Kroll, IMC,
 * Grant Thornton, Optiver x2, Perpay, Mercor, Upstart, AMD x3, Anduril,
 * Palantir x2 = 19, of which Fiserv, Kroll, Grant Thornton and Upstart
 * are inactive (active === false).
 */
const EXPECTED_S27_COUNT = 19;
const EXPECTED_INACTIVE_COUNT = 4;

interface FakeRoute {
  status?: number;
  body: string;
  reject?: boolean;
}

interface FetchLog {
  urls: string[];
  headers: Array<Record<string, string>>;
}

function fakeFetch(routes: { listings?: FakeRoute; readme?: FakeRoute }, log?: FetchLog) {
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    log?.urls.push(url);
    log?.headers.push({ ...((init?.headers as Record<string, string>) ?? {}) });
    const route = url.includes("listings.json") ? routes.listings : routes.readme;
    if (!route) throw new Error(`unexpected fetch in test: ${url}`);
    if (route.reject) throw new Error("network unreachable (test)");
    return new Response(route.body, { status: route.status ?? 200 });
  };
  return fetchImpl as typeof globalThis.fetch;
}

function makeCtx(
  routes: { listings?: FakeRoute; readme?: FakeRoute },
  fetchLog?: FetchLog,
): { ctx: FetchContext; logs: string[] } {
  const logs: string[] = [];
  return {
    ctx: {
      fetch: fakeFetch(routes, fetchLog),
      userAgent: "internship-tracker/1.0 (contact: test@example.com)",
      now: new Date("2026-09-18T12:00:00Z"),
      log: (message: string) => logs.push(message),
    },
    logs,
  };
}

/** A minimal valid listings.json entry for synthetic payloads. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: "Simplify",
    category: "Software",
    company_name: "Acme",
    id: "00000000-0000-4000-8000-000000000001",
    title: "Software Engineer Intern",
    active: true,
    terms: ["Summer 2027"],
    date_updated: 1775086186,
    date_posted: 1775081547,
    url: "https://example.com/jobs/1",
    locations: ["Atlanta, GA"],
    company_url: "https://simplify.jobs/c/Acme",
    is_visible: true,
    sponsorship: "Other",
    degrees: ["Bachelor's"],
    ...overrides,
  };
}

describe("simplifyAdapter — primary listings.json path", () => {
  it("keeps exactly the Summer 2027 + is_visible entries, including inactive ones", async () => {
    const { ctx } = makeCtx({
      listings: { body: listingsFixture },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);

    expect(result.listings).toHaveLength(EXPECTED_S27_COUNT);
    for (const listing of result.listings) {
      expect(listing.source).toBe("simplify");
      expect(listing.terms).toContain("Summer 2027");
    }
    const inactive = result.listings.filter((l) => !l.active);
    expect(inactive).toHaveLength(EXPECTED_INACTIVE_COUNT);
    expect(inactive.map((l) => l.company).sort()).toEqual([
      "Fiserv",
      "Grant Thornton",
      "Kroll",
      "Upstart",
    ]);
  });

  it("returns the raw listings.json text verbatim as rawPayload", async () => {
    const { ctx } = makeCtx({
      listings: { body: listingsFixture },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    expect(result.rawPayload).toBe(listingsFixture);
  });

  it("sends the ctx userAgent as the User-Agent header on both requests", async () => {
    const fetchLog: FetchLog = { urls: [], headers: [] };
    const { ctx } = makeCtx(
      { listings: { body: "[]" }, readme: { body: readmeFixture } },
      fetchLog,
    );
    await simplifyAdapter.fetch(ctx);
    expect(fetchLog.urls).toHaveLength(2);
    for (const headers of fetchLog.headers) {
      expect(headers["User-Agent"]).toBe(ctx.userAgent);
    }
  });

  it("maps fields correctly (unix seconds → Date, verbatim url, raw passthrough)", async () => {
    const { ctx } = makeCtx({
      listings: { body: listingsFixture },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    const aquatic = result.listings.find(
      (l) => l.sourceUid === "15636fe2-413f-4e5d-b6c9-0d42dc5edc5f",
    );
    expect(aquatic).toBeDefined();
    expect(aquatic).toMatchObject({
      source: "simplify",
      company: "Aquatic Capital Management",
      title: "Software Engineer Intern",
      url: "https://job-boards.greenhouse.io/aquaticcapitalmanagement/jobs/8489233002",
      locations: ["London, UK", "Chicago, IL"],
      category: "Software",
      terms: ["Summer 2027"],
      degrees: ["Bachelor's", "Master's", "PhD"],
      active: true,
      companyFaangPlus: false,
    });
    expect(aquatic?.postedAt).toEqual(new Date(1775081547 * 1000));
    expect(aquatic?.updatedAt).toEqual(new Date(1775086186 * 1000));
    expect(aquatic?.raw).toMatchObject({
      id: "15636fe2-413f-4e5d-b6c9-0d42dc5edc5f",
      company_url: "https://simplify.jobs/c/Aquatic-Capital-Management",
    });
  });

  it.each([
    ["Other", undefined],
    ["Does Not Offer Sponsorship", "Does Not Offer Sponsorship"],
    ["Offers Sponsorship", "Offers Sponsorship"],
    ["U.S. Citizenship is Required", "U.S. Citizenship is Required"],
  ])("maps sponsorship %j → %j", async (raw, expected) => {
    const payload = JSON.stringify([entry({ sponsorship: raw })]);
    const { ctx } = makeCtx({
      listings: { body: payload },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sponsorship).toBe(expected);
  });

  it("flags companyFaangPlus via the README 🔥 set, case/whitespace-insensitively", async () => {
    const payload = JSON.stringify([
      entry({ company_name: "  tesla ", id: "00000000-0000-4000-8000-00000000000a" }),
      entry({ company_name: "Waymo", id: "00000000-0000-4000-8000-00000000000b" }),
      entry({ company_name: "TRC Companies", id: "00000000-0000-4000-8000-00000000000c" }),
    ]);
    const { ctx } = makeCtx({
      listings: { body: payload },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    const byUid = new Map(result.listings.map((l) => [l.sourceUid, l]));
    expect(byUid.get("00000000-0000-4000-8000-00000000000a")?.companyFaangPlus).toBe(true);
    expect(byUid.get("00000000-0000-4000-8000-00000000000b")?.companyFaangPlus).toBe(true);
    expect(byUid.get("00000000-0000-4000-8000-00000000000c")?.companyFaangPlus).toBe(false);
  });

  it("skips a corrupted entry (missing title) but keeps the rest, and logs it", async () => {
    const corrupt = entry({ id: "00000000-0000-4000-8000-0000000000bad" });
    delete corrupt.title;
    const payload = JSON.stringify([
      entry({ id: "00000000-0000-4000-8000-000000000011" }),
      corrupt,
      entry({ id: "00000000-0000-4000-8000-000000000012" }),
    ]);
    const { ctx, logs } = makeCtx({
      listings: { body: payload },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    expect(result.listings.map((l) => l.sourceUid)).toEqual([
      "00000000-0000-4000-8000-000000000011",
      "00000000-0000-4000-8000-000000000012",
    ]);
    expect(logs.some((m) => m.includes("skipped 1"))).toBe(true);
  });

  it("returns an empty result (not a crash) for an empty payload", async () => {
    const { ctx } = makeCtx({
      listings: { body: "[]" },
      readme: { body: readmeFixture },
    });
    const result = await simplifyAdapter.fetch(ctx);
    expect(result.listings).toEqual([]);
    expect(result.rawPayload).toBe("[]");
  });

  it("does not fail when the README fetch fails — FAANG flags just stay false", async () => {
    for (const readme of [
      { body: "not found", status: 404 } satisfies FakeRoute,
      { body: "", reject: true } satisfies FakeRoute,
    ]) {
      const { ctx, logs } = makeCtx({ listings: { body: listingsFixture }, readme });
      const result = await simplifyAdapter.fetch(ctx);
      expect(result.listings).toHaveLength(EXPECTED_S27_COUNT);
      expect(result.listings.every((l) => l.companyFaangPlus === false)).toBe(true);
      expect(logs.some((m) => m.includes("README"))).toBe(true);
    }
  });
});

describe("extractFaangCompanies", () => {
  it("extracts exactly the 🔥 companies from table cells, not the legend line", () => {
    const companies = extractFaangCompanies(readmeFixture);
    expect(companies).toEqual(new Set(["Tesla", "Amazon", "Waymo", "Visa"]));
    // The legend line "- 🔥 FAANG+ company" must not leak in as a company.
    for (const name of companies) {
      expect(name).not.toMatch(/FAANG/i);
    }
  });
});

describe("simplifyAdapter — README table fallback", () => {
  it.each([
    ["non-200 listings.json", { body: "Internal Server Error", status: 500 }],
    ["unparseable listings.json", { body: "{{{ not json" }],
    ["non-array listings.json", { body: '{"oops": true}' }],
  ] as Array<[string, FakeRoute]>)(
    "parses README tables when the JSON is unusable (%s)",
    async (_label, listings) => {
      const { ctx, logs } = makeCtx({ listings, readme: { body: readmeFixture } });
      const result = await simplifyAdapter.fetch(ctx);

      expect(logs.some((m) => m.includes("fallback"))).toBe(true);
      expect(result.rawPayload).toBe(readmeFixture);
      expect(result.listings.length).toBeGreaterThanOrEqual(10);
      for (const listing of result.listings) {
        // Every fallback row must round-trip through the frozen contract.
        expect(NormalizedListingSchema.safeParse(listing).success).toBe(true);
        expect(listing.source).toBe("simplify");
        expect(listing.terms).toEqual(["Summer 2027"]);
      }

      const teslaUrl =
        "https://www.tesla.com/careers/search/job/284004?utm_source=Simplify&ref=Simplify";
      const tesla = result.listings.find((l) => l.company === "Tesla");
      expect(tesla).toMatchObject({
        title: "Internship - Software Engineering - People Products - Summer 2027",
        url: teslaUrl,
        sourceUid: createHash("sha256").update(teslaUrl).digest("hex"),
        locations: ["Palo Alto, CA"],
        active: true,
        companyFaangPlus: true,
      });

      // Non-🔥 company stays unflagged.
      const trc = result.listings.find((l) => l.company === "TRC Companies");
      expect(trc?.companyFaangPlus).toBe(false);

      // <br>-separated locations split into an array.
      const amazon = result.listings.find((l) => l.company === "Amazon");
      expect(amazon?.locations).toEqual([
        "Seattle, WA",
        "Arlington County, Arlington, VA",
      ]);

      // 🎓 marker → conservative advanced-degree stand-in, stripped from title.
      const lennox = result.listings.find((l) => l.company === "Lennox International");
      expect(lennox).toMatchObject({
        title: "IoT Intern",
        degrees: ["Master's"],
        companyFaangPlus: false,
      });

      // ↳ continuation row inherits the previous company (and its 🔥 flag).
      const visaRows = result.listings.filter((l) => l.company === "Visa");
      expect(visaRows).toHaveLength(2);
      const bellevue = visaRows.find((l) => l.locations.includes("Bellevue, WA"));
      expect(bellevue).toBeDefined();
      expect(bellevue?.companyFaangPlus).toBe(true);
      expect(bellevue?.url).toContain("visa.wd5.myworkdayjobs.com");

      // sourceUids are distinct sha256 hashes.
      const uids = result.listings.map((l) => l.sourceUid);
      expect(new Set(uids).size).toBe(uids.length);
      for (const uid of uids) {
        expect(uid).toMatch(/^[0-9a-f]{64}$/);
      }
    },
  );

  it("throws when both listings.json and the README are unavailable", async () => {
    const { ctx } = makeCtx({
      listings: { body: "oops", status: 500 },
      readme: { body: "gone", status: 404 },
    });
    await expect(simplifyAdapter.fetch(ctx)).rejects.toThrow(/README unavailable/);
  });
});
