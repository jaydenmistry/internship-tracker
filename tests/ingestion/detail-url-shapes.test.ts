import { describe, expect, it, vi } from "vitest";
import { fetchDetail, type DetailContext } from "@/lib/ingestion/detail";

/**
 * Regression tests for two ATS URL shapes found in live data that the parsers
 * rejected as unsupported_url, silently costing posting text on ~10 listings.
 */

function makeCtx(handler: (url: string) => Response): { ctx: DetailContext; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    return handler(url);
  }) as unknown as typeof fetch;

  return {
    urls,
    ctx: {
      fetch: fetchImpl,
      userAgent: "test-agent",
      now: new Date("2026-09-19T00:00:00Z"),
      log: () => {},
      sleep: async () => {},
      robotsCache: new Map(),
      urlCache: new Map(),
      nowMs: () => 0,
      lastFetchByHost: new Map(),
    },
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const WORKDAY_BODY = {
  jobPostingInfo: {
    title: "Silicon Hardware Engineering - Intern",
    jobDescription: "<p>Work on silicon bring-up in C and Python.</p>",
    jobReqId: "JR0286829",
  },
};

describe("Workday URLs with a lowercase locale segment", () => {
  it("skips 'en-us' the same as 'en-US' when building the cxs URL", async () => {
    const { ctx, urls } = makeCtx((url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      return json(WORKDAY_BODY);
    });

    const result = await fetchDetail(
      "https://intel.wd1.myworkdayjobs.com/en-us/external/job/US-Oregon-Hillsboro/Silicon-Hardware-Engineering---Intern_JR0286829",
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(result.requisitionId).toBe("JR0286829");
    expect(result.postingText).toContain("silicon bring-up");
    // The locale must NOT become the site name, or the cxs URL 404s.
    const cxs = urls.find((u) => u.includes("/wday/cxs/"));
    expect(cxs).toBe(
      "https://intel.wd1.myworkdayjobs.com/wday/cxs/intel/external/job/Silicon-Hardware-Engineering---Intern_JR0286829",
    );
    expect(cxs).not.toContain("en-us");
  });

  it("still handles the uppercase locale form", async () => {
    const { ctx, urls } = makeCtx((url) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : json(WORKDAY_BODY),
    );
    await fetchDetail(
      "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Boston/Intern_JR1_1",
      ctx,
    );
    expect(urls.find((u) => u.includes("/wday/cxs/"))).toBe(
      "https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/careers/job/Intern_JR1_1",
    );
  });
});

describe("Greenhouse embed URLs", () => {
  const GH_JOB = {
    id: 8175504,
    title: "Product Manager Intern",
    content: "&lt;p&gt;Build internal tooling in TypeScript.&lt;/p&gt;",
    application_deadline: null,
    requisition_id: "GH-1",
  };

  it("uses the board from the ?for= parameter when present", async () => {
    const { ctx, urls } = makeCtx((url) =>
      url.endsWith("/robots.txt") ? new Response("", { status: 404 }) : json(GH_JOB),
    );

    const result = await fetchDetail(
      "https://job-boards.greenhouse.io/embed/job_app?for=coinbase&token=8175504",
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(result.postingText).toContain("TypeScript");
    expect(urls).toContain("https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/8175504");
  });

  it("discovers the board from the redirect when the URL has only a token", async () => {
    const { ctx, urls } = makeCtx((url) => {
      if (url.endsWith("/robots.txt")) return new Response("", { status: 404 });
      if (url.includes("boards-api")) return json(GH_JOB);
      // The embed page redirects, exposing the board as ?for=.
      const redirected = new Response("<html></html>", { status: 200 });
      Object.defineProperty(redirected, "url", {
        value: "https://job-boards.greenhouse.io/embed/job_app?for=coinbase&token=8175504",
      });
      return redirected;
    });

    const result = await fetchDetail(
      "https://boards.greenhouse.io/embed/job_app?token=8175504",
      ctx,
    );

    expect(result.status).toBe("ok");
    expect(urls).toContain("https://boards-api.greenhouse.io/v1/boards/coinbase/jobs/8175504");
  });

  it("reports unsupported_url for an embed URL with no token at all", async () => {
    const { ctx } = makeCtx(() => new Response("", { status: 404 }));
    const result = await fetchDetail("https://boards.greenhouse.io/embed/job_app", ctx);
    expect(result.status).toBe("unsupported_url");
  });
});
