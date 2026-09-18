import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedUrl,
  internListAdapter,
  setSleepImplForTests,
} from "@/lib/ingestion/adapters/intern-list";
import {
  NormalizedListingSchema,
  type FetchContext,
} from "@/lib/ingestion/adapters/types";

const FIXTURES_DIR = path.resolve(
  import.meta.dirname,
  "../fixtures/intern-list",
);
const SHELL_URL = "https://www.intern-list.com/?k=swe";
const MINISITE_URL = "https://jobright.ai/minisites-jobs/intern/us/swe?embed=true";

const shellHtml = readFileSync(path.join(FIXTURES_DIR, "page-swe.html"), "utf8");
const minisiteHtml = readFileSync(
  path.join(FIXTURES_DIR, "minisite-us-swe.html"),
  "utf8",
);

interface FakeFetchCall {
  url: string;
  init: RequestInit | undefined;
}

function makeCtx(routes: Record<string, string>): {
  ctx: FetchContext;
  calls: FakeFetchCall[];
  logs: string[];
} {
  const calls: FakeFetchCall[] = [];
  const logs: string[] = [];
  const fakeFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const body = routes[url];
      if (body === undefined) {
        throw new Error(`unexpected fetch in test: ${url}`);
      }
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
  );
  const ctx: FetchContext = {
    fetch: fakeFetch as unknown as typeof globalThis.fetch,
    userAgent: "internship-tracker-test/1.0 (jmistry2004@gmail.com)",
    now: new Date("2026-09-18T12:00:00Z"),
    log: (message) => logs.push(message),
  };
  return { ctx, calls, logs };
}

/** Wrap job records in a minimal minisite page for shape-drift tests. */
function minisitePage(nextData: unknown): string {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    nextData,
  )}</script></body></html>`;
}

let restoreSleep: () => void;
let sleepSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sleepSpy = vi.fn(async () => {});
  restoreSleep = setSleepImplForTests(
    sleepSpy as unknown as (ms: number) => Promise<void>,
  );
});

afterEach(() => {
  restoreSleep();
});

describe("assertAllowedUrl", () => {
  it("throws on jobright.ai /api paths", () => {
    expect(() =>
      assertAllowedUrl("https://jobright.ai/api/intern-list/conf"),
    ).toThrow(/robots/);
    expect(() => assertAllowedUrl("https://jobright.ai/api/")).toThrow(/robots/);
    expect(() => assertAllowedUrl("https://www.jobright.ai/api/jobs")).toThrow(
      /robots/,
    );
  });

  it("allows the two page URLs the adapter fetches", () => {
    expect(() => assertAllowedUrl(SHELL_URL)).not.toThrow();
    expect(() => assertAllowedUrl(MINISITE_URL)).not.toThrow();
  });
});

describe("internListAdapter.fetch", () => {
  it("discovers /us/swe (not /ca/swe) from the Webflow shell and fetches the minisite", async () => {
    const { ctx, calls } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisiteHtml,
    });
    await internListAdapter.fetch(ctx);

    expect(calls.map((c) => c.url)).toEqual([SHELL_URL, MINISITE_URL]);
    // Rate limit between the two requests, stubbed so the test doesn't sleep.
    expect(sleepSpy).toHaveBeenCalledWith(1000);
    // Real User-Agent on every request.
    for (const call of calls) {
      expect(new Headers(call.init?.headers).get("User-Agent")).toBe(
        ctx.userAgent,
      );
    }
  });

  it("returns exactly 50 Zod-valid listings and the minisite HTML as rawPayload", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisiteHtml,
    });
    const result = await internListAdapter.fetch(ctx);

    expect(result.listings).toHaveLength(50);
    expect(result.rawPayload).toBe(minisiteHtml);
    for (const listing of result.listings) {
      expect(() => NormalizedListingSchema.parse(listing)).not.toThrow();
      expect(listing.source).toBe("intern-list");
      expect(listing.active).toBe(true);
      expect(listing.url).not.toContain("?");
    }
  });

  it("maps the Together AI record field by field", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisiteHtml,
    });
    const result = await internListAdapter.fetch(ctx);
    const listing = result.listings.find((l) => l.company === "Together AI");

    expect(listing).toBeDefined();
    expect(listing?.sourceUid).toBe("6aad91e7de327d3e210d33d9");
    expect(listing?.title).toBe(
      "Research Intern, Frontier Agents (Summer 2027)",
    );
    // utm query string stripped down to the canonical path.
    expect(listing?.url).toBe(
      "https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9",
    );
    expect(listing?.locations).toEqual(["San Francisco, CA"]);
    expect(listing?.salary).toBe("$58-$70/hr");
    expect(listing?.terms).toEqual(["Summer 2027"]);
    expect(listing?.postingText).toBeTruthy();
    expect(listing?.postingText).toContain("Masters or Ph.D");
    expect(listing?.postedAt?.getTime()).toBe(1789734775000);
    // h1bSponsored "Not Sure" → no sponsorship claim.
    expect(listing?.sponsorship).toBeUndefined();
    // workModel "On Site" → not remote.
    expect(listing?.remote).toBe(false);
    // jobFunction null → default category.
    expect(listing?.category).toBe("Software Engineering");
    // raw is the original record, verbatim.
    expect((listing?.raw as { applyUrl: string }).applyUrl).toContain(
      "utm_source",
    );
  });

  it("maps workModel and h1bSponsored across the fixture", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisiteHtml,
    });
    const result = await internListAdapter.fetch(ctx);

    const remotes = result.listings.filter((l) => l.remote);
    expect(remotes.length).toBeGreaterThan(0);
    for (const listing of result.listings) {
      const raw = listing.raw as { workModel: string; h1bSponsored: string };
      expect(listing.remote).toBe(raw.workModel === "Remote");
      if (raw.h1bSponsored === "Not Sure") {
        expect(listing.sponsorship).toBeUndefined();
      } else {
        expect(listing.sponsorship).toBe(`H1B: ${raw.h1bSponsored}`);
      }
    }
  });

  it("maps hireTime → terms per the <year>-<season> pattern", async () => {
    const jobs = [
      { hireTime: "2027-Summer", expected: ["Summer 2027"] },
      { hireTime: "2027-June", expected: ["June 2027"] },
      { hireTime: "2027", expected: [] },
      { hireTime: "Summer", expected: [] },
      { hireTime: "", expected: [] },
    ].map(({ hireTime }, i) => ({
      id: `job-${i}`,
      title: "SWE Intern",
      company: "Acme",
      location: "Athens, GA",
      salary: null,
      postedDate: 1789734775000,
      applyUrl: `https://jobright.ai/jobs/info/job-${i}?utm_source=x`,
      workModel: "Hybrid",
      jobFunction: null,
      qualifications: null,
      h1bSponsored: "Not Sure",
      hireTime,
    }));
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisitePage({
        props: { pageProps: { initialJobs: jobs, initialTotal: jobs.length } },
      }),
    });
    const result = await internListAdapter.fetch(ctx);

    expect(result.listings.map((l) => l.terms)).toEqual([
      ["Summer 2027"],
      ["June 2027"],
      [],
      [],
      [],
    ]);
    // Empty qualifications → no postingText, null salary → undefined.
    expect(result.listings[0].postingText).toBeUndefined();
    expect(result.listings[0].salary).toBeUndefined();
  });

  it("skips a job record missing a required field while parsing the rest", async () => {
    const good = {
      id: "good-1",
      title: "SWE Intern",
      company: "Acme",
      location: "Atlanta, GA",
      salary: "$30/hr",
      postedDate: 1789734775000,
      applyUrl: "https://jobright.ai/jobs/info/good-1?utm_source=x",
      workModel: "Remote",
      jobFunction: null,
      qualifications: "BS in CS",
      h1bSponsored: "No",
      hireTime: "2027-Summer",
    };
    const bad = { ...good, id: "bad-1", company: undefined };
    const { ctx, logs } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisitePage({
        props: { pageProps: { initialJobs: [bad, good], initialTotal: 2 } },
      }),
    });
    const result = await internListAdapter.fetch(ctx);

    expect(result.listings).toHaveLength(1);
    expect(result.listings[0].sourceUid).toBe("good-1");
    expect(result.listings[0].remote).toBe(true);
    expect(result.listings[0].sponsorship).toBe("H1B: No");
    expect(logs.some((l) => /skipping job record/.test(l))).toBe(true);
    expect(logs.some((l) => /skipped 1\/2/.test(l))).toBe(true);
  });

  it("throws when the shell has no /us swe category element", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]:
        '<html><body><h2 data-job-path="/ca/swe" short-link="swe">SWE</h2></body></html>',
    });
    await expect(internListAdapter.fetch(ctx)).rejects.toThrow(
      /category element/,
    );
  });

  it("throws when the minisite has no __NEXT_DATA__ script", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: "<html><body><p>nothing here</p></body></html>",
    });
    await expect(internListAdapter.fetch(ctx)).rejects.toThrow(/__NEXT_DATA__/);
  });

  it("throws on a __NEXT_DATA__ shape mismatch instead of returning []", async () => {
    const { ctx } = makeCtx({
      [SHELL_URL]: shellHtml,
      [MINISITE_URL]: minisitePage({ props: { pageProps: { jobs: [] } } }),
    });
    await expect(internListAdapter.fetch(ctx)).rejects.toThrow(
      /shape mismatch/,
    );
  });

  it("throws on a non-OK HTTP response", async () => {
    const calls: string[] = [];
    const ctx: FetchContext = {
      fetch: (async (input: RequestInfo | URL) => {
        calls.push(String(input));
        return new Response("gone", { status: 404 });
      }) as typeof globalThis.fetch,
      userAgent: "test",
      now: new Date(),
      log: () => {},
    };
    await expect(internListAdapter.fetch(ctx)).rejects.toThrow(/HTTP 404/);
    expect(calls).toEqual([SHELL_URL]);
  });
});
