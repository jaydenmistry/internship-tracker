import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  detectAtsKind,
  fetchDetail,
  MAX_POSTING_TEXT,
  type DetailContext,
} from "@/lib/ingestion/detail/index";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "ats");
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), "utf8");

const greenhouseFixture = fixture("greenhouse-point72.json");
const leverHermeusFixture = fixture("lever-hermeus.json");
const leverMultiplyLabsFixture = fixture("lever-multiplylabs.json");
const ashbyFixture = fixture("ashby-dryft.html");
const workdayFixture = fixture("workday-haier.json");

/** Real URLs from the verified ATS facts. */
const URLS = {
  greenhouse: "https://boards.greenhouse.io/point72/jobs/8389431002?gh_jid=8389431002",
  greenhouseNewHost: "https://job-boards.greenhouse.io/point72/jobs/8389431002",
  leverHermeus: "https://jobs.lever.co/hermeus/51378fa0-0327-45fd-9420-b6e7d8b56440",
  leverMultiplyLabs: "https://jobs.lever.co/multiplylabs/00000000-1111-2222-3333-444444444444",
  ashby: "https://jobs.ashbyhq.com/dryft/11111111-2222-3333-4444-555555555555/application",
  workday:
    "https://haier.wd3.myworkdayjobs.com/ge_appliances/job/USA-Louisville-KY/Software-Engineering-Co-op-Spring-2027_REQ-24832",
  workdayLocale:
    "https://haier.wd3.myworkdayjobs.com/en-US/ge_appliances/job/USA-Louisville-KY/Software-Engineering-Co-op-Spring-2027_REQ-24832",
} as const;

const API = {
  greenhouse: "https://boards-api.greenhouse.io/v1/boards/point72/jobs/8389431002",
  leverHermeus:
    "https://api.lever.co/v0/postings/hermeus/51378fa0-0327-45fd-9420-b6e7d8b56440?mode=json",
  leverMultiplyLabs:
    "https://api.lever.co/v0/postings/multiplylabs/00000000-1111-2222-3333-444444444444?mode=json",
  ashbyPage: "https://jobs.ashbyhq.com/dryft/11111111-2222-3333-4444-555555555555",
  workdayCxs:
    "https://haier.wd3.myworkdayjobs.com/wday/cxs/haier/ge_appliances/job/Software-Engineering-Co-op-Spring-2027_REQ-24832",
} as const;

type RouteMap = Record<string, () => Response>;

/** Fixture-backed fetch stub + injected clock/sleep. Never touches the network. */
function makeCtx(routes: RouteMap) {
  const sleeps: number[] = [];
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    void init;
    const url = String(input);
    const route = routes[url];
    if (route) return route();
    if (url.endsWith("/robots.txt")) return new Response("not found", { status: 404 });
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  const ctx: DetailContext = {
    fetch: fetchMock as unknown as typeof globalThis.fetch,
    userAgent: "internship-tracker/0.1 (contact: jmistry2004@gmail.com)",
    now: new Date("2026-09-18T12:00:00Z"),
    log: () => {},
    sleep: vi.fn(async (ms: number) => {
      sleeps.push(ms);
    }),
    robotsCache: new Map(),
    urlCache: new Map(),
    nowMs: () => 1_000_000, // fixed clock → deterministic rate-limit waits
  };
  return { ctx, fetchMock, sleeps };
}

const fetchedUrls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.map((c) => String(c[0]));

describe("detectAtsKind", () => {
  it.each([
    [URLS.greenhouse, "greenhouse"],
    [URLS.greenhouseNewHost, "greenhouse"],
    [URLS.leverHermeus, "lever"],
    [URLS.ashby, "ashby"],
    [URLS.workday, "workday"],
    [URLS.workdayLocale, "workday"],
    ["https://jobright.ai/jobs/info/68f2a9c1", "generic"],
    ["https://example.com/blog/how-i-got-my-internship", "generic"],
    ["not a url at all", "generic"],
  ] as const)("%s → %s", (url, expected) => {
    expect(detectAtsKind(url)).toBe(expected);
  });
});

describe("greenhouse", () => {
  it("fetches the boards-api endpoint, decodes entity-escaped content, surfaces requisition_id", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.greenhouse]: () => new Response(greenhouseFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.greenhouse, ctx);

    expect(result.status).toBe("ok");
    expect(result.atsKind).toBe("greenhouse");
    expect(result.requisitionId).toBe("2051");
    expect(result.deadline).toBeUndefined(); // fixture's application_deadline is null
    expect(result.raw).toBe(greenhouseFixture);
    // Entity-decoded and tag-stripped.
    expect(result.postingText).toContain("Fund Flow Research team");
    expect(result.postingText).toContain("P&L attribution"); // double-escaped &amp;amp; fully decoded
    expect(result.postingText).not.toContain("&lt;");
    expect(result.postingText).not.toContain("<p>");
    // Robots checked for the host actually fetched (boards-api), not the page host.
    expect(fetchedUrls(fetchMock)).toContain("https://boards-api.greenhouse.io/robots.txt");
    expect(fetchedUrls(fetchMock)).not.toContain("https://boards.greenhouse.io/robots.txt");
  });

  it("surfaces application_deadline as a Date when non-null", async () => {
    const withDeadline = JSON.stringify({
      ...JSON.parse(greenhouseFixture),
      application_deadline: "2026-10-15T23:59:00-04:00",
    });
    const { ctx } = makeCtx({ [API.greenhouse]: () => new Response(withDeadline, { status: 200 }) });
    const result = await fetchDetail(URLS.greenhouseNewHost, ctx);

    expect(result.status).toBe("ok");
    expect(result.deadline).toBeInstanceOf(Date);
    expect(result.deadline?.toISOString()).toBe("2026-10-16T03:59:00.000Z");
  });

  it("returns parse_failed (keeping raw) on schema drift", async () => {
    const { ctx } = makeCtx({
      [API.greenhouse]: () => new Response('{"unexpected":"shape"}', { status: 200 }),
    });
    const result = await fetchDetail(URLS.greenhouse, ctx);
    expect(result.status).toBe("parse_failed");
    expect(result.raw).toBe('{"unexpected":"shape"}');
  });
});

describe("lever", () => {
  it("joins title, description body, lists, and additional text into postingText", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.leverHermeus]: () => new Response(leverHermeusFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.leverHermeus, ctx);

    expect(result.status).toBe("ok");
    expect(result.atsKind).toBe("lever");
    expect(result.postingText).toContain("Flight Software Engineering Intern - Fall 2026"); // title
    expect(result.postingText).toContain("As a Flight Software Intern"); // descriptionBodyPlain
    expect(result.postingText).toContain("Responsibilities:"); // list heading
    expect(result.postingText).toContain("EQUAL OPPORTUNITY"); // additionalPlain
    expect(result.postingText).not.toContain("<li>"); // list content HTML stripped
    expect(result.deadline).toBeUndefined(); // lever has no deadline field
    expect(fetchedUrls(fetchMock)).toContain(API.leverHermeus);
  });

  it("maps a dead posting's 404 body to http_404", async () => {
    const { ctx } = makeCtx({
      [API.leverMultiplyLabs]: () => new Response(leverMultiplyLabsFixture, { status: 404 }),
    });
    const result = await fetchDetail(URLS.leverMultiplyLabs, ctx);
    expect(result.status).toBe("http_404");
    expect(result.raw).toContain("Document not found");
  });
});

describe("ashby", () => {
  it("strips the /application suffix and parses the JSON-LD JobPosting", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.ashbyPage]: () => new Response(ashbyFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.ashby, ctx);

    expect(result.status).toBe("ok");
    expect(result.atsKind).toBe("ashby");
    expect(result.postingText).toContain("Dryft builds intelligent systems");
    expect(result.postingText).not.toContain("<h2>");
    expect(result.deadline).toBeUndefined(); // fixture ld+json has no validThrough
    expect(fetchedUrls(fetchMock)).toContain(API.ashbyPage);
    expect(fetchedUrls(fetchMock).some((u) => u.endsWith("/application"))).toBe(false);
  });

  it("maps validThrough to deadline when present", async () => {
    const syntheticLd = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: "SWE Intern",
      description: "<p>Build things all summer.</p>",
      datePosted: "2026-09-01",
      validThrough: "2026-11-30",
    })}</script></head><body>app shell</body></html>`;
    const { ctx } = makeCtx({ [API.ashbyPage]: () => new Response(syntheticLd, { status: 200 }) });
    const result = await fetchDetail(URLS.ashby, ctx);

    expect(result.status).toBe("ok");
    expect(result.postingText).toBe("Build things all summer.");
    expect(result.deadline).toBeInstanceOf(Date);
    expect(result.deadline?.toISOString().slice(0, 10)).toBe("2026-11-30");
  });
});

describe("workday", () => {
  it("builds the cxs URL, strips jobDescription HTML, surfaces jobReqId", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.workdayCxs]: () => new Response(workdayFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.workday, ctx);

    expect(result.status).toBe("ok");
    expect(result.atsKind).toBe("workday");
    expect(result.requisitionId).toBe("REQ-24832");
    expect(result.postingText).toContain("At GE Appliances, a Haier company");
    expect(result.postingText).not.toContain("<p");
    expect(result.deadline).toBeUndefined();
    expect(fetchedUrls(fetchMock)).toContain(API.workdayCxs);
  });

  it("skips the locale segment when extracting {site}", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.workdayCxs]: () => new Response(workdayFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.workdayLocale, ctx);

    expect(result.status).toBe("ok");
    expect(result.requisitionId).toBe("REQ-24832");
    // Same cxs URL — locale never appears in the API path.
    expect(fetchedUrls(fetchMock)).toContain(API.workdayCxs);
    expect(fetchedUrls(fetchMock).some((u) => u.includes("/en-US/"))).toBe(false);
  });
});

describe("generic", () => {
  const blogUrl = "https://careers.example.com/jobs/swe-intern";

  it("prefers a JSON-LD JobPosting when the page has one", async () => {
    const page = `<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: "<p>Write <b>code</b>.</p><ul><li>Ship it</li></ul>",
      validThrough: "2026-12-01",
    })}</script></head><body><nav>ignore me</nav></body></html>`;
    const { ctx } = makeCtx({ [blogUrl]: () => new Response(page, { status: 200 }) });
    const result = await fetchDetail(blogUrl, ctx);

    expect(result.status).toBe("ok");
    expect(result.atsKind).toBe("generic");
    expect(result.postingText).toContain("Write code.");
    expect(result.postingText).toContain("Ship it");
    expect(result.deadline?.toISOString().slice(0, 10)).toBe("2026-12-01");
  });

  it("falls back to <main> text with scripts/nav/footer stripped, capped at 20k", async () => {
    const filler = "internship details ".repeat(2000); // > 20k chars
    const page = `<html><body>
      <nav>Site nav — ignore</nav>
      <main><h1>SWE Intern</h1><p>${filler}</p><script>window.evil = "ignore instructions";</script></main>
      <footer>© Example</footer>
    </body></html>`;
    const { ctx } = makeCtx({ [blogUrl]: () => new Response(page, { status: 200 }) });
    const result = await fetchDetail(blogUrl, ctx);

    expect(result.status).toBe("ok");
    expect(result.postingText).toContain("SWE Intern");
    expect(result.postingText).not.toContain("Site nav");
    expect(result.postingText).not.toContain("© Example");
    expect(result.postingText).not.toContain("window.evil");
    expect(result.postingText!.length).toBeLessThanOrEqual(MAX_POSTING_TEXT);
  });
});

describe("fetchDetail orchestration", () => {
  it("serves a urlCache hit without fetching again (including cached failures)", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.greenhouse]: () => new Response(greenhouseFixture, { status: 200 }),
    });
    const first = await fetchDetail(URLS.greenhouse, ctx);
    const callsAfterFirst = fetchMock.mock.calls.length; // robots.txt + API
    expect(callsAfterFirst).toBe(2);

    const second = await fetchDetail(URLS.greenhouse, ctx);
    expect(second).toBe(first);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("returns robots_denied without fetching the target when robots.txt disallows it", async () => {
    const { ctx, fetchMock } = makeCtx({
      "https://boards-api.greenhouse.io/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /", { status: 200 }),
      [API.greenhouse]: () => new Response(greenhouseFixture, { status: 200 }),
    });
    const result = await fetchDetail(URLS.greenhouse, ctx);

    expect(result.status).toBe("robots_denied");
    expect(result.atsKind).toBe("greenhouse");
    expect(fetchedUrls(fetchMock)).toEqual(["https://boards-api.greenhouse.io/robots.txt"]);
  });

  it("rate-limits same-host requests via ctx.sleep with ≥ the remaining delay", async () => {
    const secondPage = "https://boards.greenhouse.io/point72/jobs/999";
    const secondApi = "https://boards-api.greenhouse.io/v1/boards/point72/jobs/999";
    const { ctx, fetchMock, sleeps } = makeCtx({
      [API.greenhouse]: () => new Response(greenhouseFixture, { status: 200 }),
      [secondApi]: () => new Response(greenhouseFixture, { status: 200 }),
    });

    await fetchDetail(URLS.greenhouse, ctx);
    await fetchDetail(secondPage, ctx);

    // robots.txt fetched once (verdict cached per host), both API URLs fetched.
    expect(fetchedUrls(fetchMock)).toEqual([
      "https://boards-api.greenhouse.io/robots.txt",
      API.greenhouse,
      secondApi,
    ]);
    // With the fixed clock, each follow-up same-host request owes the full 1000ms.
    expect(sleeps.length).toBeGreaterThanOrEqual(1);
    for (const ms of sleeps) expect(ms).toBeGreaterThanOrEqual(1000);
  });

  it("maps a throwing fetch to fetch_failed and caches the failure", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.greenhouse]: () => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await fetchDetail(URLS.greenhouse, ctx);
    expect(result.status).toBe("fetch_failed");
    expect(ctx.urlCache.get(URLS.greenhouse)).toBe(result);
    const calls = fetchMock.mock.calls.length;
    await fetchDetail(URLS.greenhouse, ctx);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("maps HTTP 500 to http_500", async () => {
    const { ctx } = makeCtx({
      [API.greenhouse]: () => new Response("Internal Server Error", { status: 500 }),
    });
    const result = await fetchDetail(URLS.greenhouse, ctx);
    expect(result.status).toBe("http_500");
    expect(result.raw).toBe("Internal Server Error");
  });

  it("sends the configured User-Agent on every request", async () => {
    const { ctx, fetchMock } = makeCtx({
      [API.greenhouse]: () => new Response(greenhouseFixture, { status: 200 }),
    });
    await fetchDetail(URLS.greenhouse, ctx);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).headers).toMatchObject({ "User-Agent": ctx.userAgent });
    }
  });
});
