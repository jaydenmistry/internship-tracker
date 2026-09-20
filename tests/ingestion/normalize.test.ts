import { describe, expect, it } from "vitest";
import {
  buildDedupKey,
  canonicalizeUrl,
  deriveCountries,
  extractRequisitionId,
  locationBucket,
  normalizeCompany,
  normalizeTitle,
  titleSimilarity,
} from "@/lib/ingestion/normalize";

describe("normalizeCompany", () => {
  it.each([
    ["Ramp, Inc.", "ramp"],
    ["Datadog, Inc", "datadog"],
    ["Cisco Systems, Inc.", "cisco systems"],
    ["Acme Corp", "acme"],
    ["Acme Corporation", "acme"],
    ["Foo Co., Ltd.", "foo"],
    ["Bar LLC", "bar"],
    ["Johnson & Johnson", "johnson johnson"],
    ["Coca-Cola Co.", "coca cola"],
    ["AMD", "amd"],
    ["  The   Trade  Desk  ", "the trade desk"],
    ["Point72", "point72"],
    // Never strips down to nothing: a company literally named a suffix survives.
    ["Co", "co"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });
});

describe("normalizeTitle", () => {
  it.each([
    ["Software Engineering Intern (Summer 2027)", "software engineering intern"],
    [
      "Software Developer, Summer 2026, Internship - 10 weeks",
      "software developer internship",
    ],
    ["2027 Software Engineer Intern", "software engineer intern"],
    ["Software Engineer Intern - Fall 2026", "software engineer intern"],
    // Req-id-looking tokens.
    ["Software Developer Internship R260002319", "software developer internship"],
    ["Software Engineering Co-op REQ-24832", "software engineering co-op"],
    ["Software Engineer Intern (2027-40012)", "software engineer intern"],
    ["Data & Analytics Intern J00171081", "data analytics intern"],
    // Bracketed qualifiers.
    ["[Remote] SWE Intern", "swe intern"],
    // co-op spellings collapse; slash punctuation becomes a space.
    ["Compiler Engineer Intern/Co-op", "compiler engineer intern co-op"],
    ["Software Engineering Coop - Spring 2027", "software engineering co-op"],
    ["Software Engineering Co op", "software engineering co-op"],
    // No aggressive synonym folding.
    ["SWE Intern", "swe intern"],
    ["SW Engineer Intern", "sw engineer intern"],
    ["  Software   Engineer   Intern  ", "software engineer intern"],
  ])("%j → %j", (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it("is idempotent (dedupe re-normalizes already-normalized titles)", () => {
    const once = normalizeTitle("Compiler Engineer Intern/Co-op (Summer 2027)");
    expect(normalizeTitle(once)).toBe(once);
  });
});

describe("locationBucket", () => {
  it.each([
    [["San Ramon, CA"], false, "san-ramon-ca"],
    [["San Ramon, CA, USA"], false, "san-ramon-ca"],
    [["Toronto, ON, Canada"], false, "toronto-on"],
    [["London, United Kingdom"], false, "london-united-kingdom"],
    // Multi-location: first parseable wins.
    [["San Francisco, CA", "New York, NY"], false, "san-francisco-ca"],
    [["???", "Austin, TX"], false, "austin-tx"],
    // Remote flag wins over everything.
    [["San Ramon, CA"], true, "remote"],
    [[], true, "remote"],
    // A literal "Remote" location string.
    [["Remote"], false, "remote"],
    // Unparseable / empty.
    [["NYC"], false, "unknown"],
    [["???"], false, "unknown"],
    [[], false, "unknown"],
  ])("%j (remote=%s) → %j", (locations, remote, expected) => {
    expect(locationBucket(locations, remote)).toBe(expected);
  });
});

describe("deriveCountries", () => {
  it.each([
    [["Atlanta, GA"], false, ["US"]],
    [["Washington, DC"], false, ["US"]],
    [["Toronto, ON, Canada"], false, ["CA"]],
    [["Toronto, ON"], false, ["CA"]],
    [["Vancouver"], false, ["CA"]],
    // Region code beats the Canadian-city fallback.
    [["Vancouver, WA"], false, ["US"]],
    [["London, UK"], false, ["UK"]],
    [["London, United Kingdom"], false, ["UK"]],
    [["Berlin, Germany"], false, ["DE"]],
    [["Dublin, Ireland"], false, ["IE"]],
    [["Amsterdam, Netherlands"], false, ["NL"]],
    [["Stockholm, Sweden"], false, ["SE"]],
    // Bare "Remote" → US (this app's context is US-remote).
    [["Remote"], false, ["US"]],
    [["Remote in USA"], false, ["US"]],
    [[], true, ["US"]],
    // Multi-country, deduped, insertion order.
    [["Atlanta, GA", "Toronto, ON"], false, ["US", "CA"]],
    [["Atlanta, GA", "Austin, TX"], false, ["US"]],
    // Unknown.
    [["Narnia"], false, []],
    [[], false, []],
  ])("%j (remote=%s) → %j", (locations, remote, expected) => {
    expect(deriveCountries(locations, remote)).toEqual(expected);
  });
});

describe("buildDedupKey", () => {
  it("composes company|title|bucket", () => {
    expect(
      buildDedupKey("AMD, Inc.", "Compiler Engineer Intern/Co-op (Summer 2027)", ["San Jose, CA"], false),
    ).toBe("amd|compiler engineer intern co-op|san-jose-ca");
  });

  it("uses remote bucket when remote", () => {
    expect(buildDedupKey("Ramp", "SWE Intern", ["New York, NY"], true)).toBe(
      "ramp|swe intern|remote",
    );
  });
});

describe("canonicalizeUrl", () => {
  it.each([
    // utm stripped, meaningful gh_jid kept, fragment dropped, host/scheme lowered.
    [
      "HTTPS://Boards.Greenhouse.io/point72/jobs/8389431002?gh_jid=8389431002&utm_source=simplify#app",
      "https://boards.greenhouse.io/point72/jobs/8389431002?gh_jid=8389431002",
    ],
    // Default port stripped, trailing slash stripped.
    ["https://example.com:443/foo/", "https://example.com/foo"],
    // Root slash kept.
    ["https://example.com/", "https://example.com/"],
    // Non-default port kept.
    ["http://example.com:8080/a", "http://example.com:8080/a"],
    // All listed tracking params stripped.
    [
      "https://jobs.lever.co/hermeus/51378fa0-0327-45fd-9420-b6e7d8b56440?lever-source=Simplify&ref=x&source=y&gh_src=z&fbclid=1&gclid=2",
      "https://jobs.lever.co/hermeus/51378fa0-0327-45fd-9420-b6e7d8b56440",
    ],
    // Other params kept in original order.
    [
      "https://careers.amd.com/jobs/91866?icims=1&b=2&a=1&utm_campaign=c",
      "https://careers.amd.com/jobs/91866?icims=1&b=2&a=1",
    ],
  ])("%j → %j", (input, expected) => {
    expect(canonicalizeUrl(input)).toBe(expected);
  });

  it("returns invalid input unchanged", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
    expect(canonicalizeUrl("")).toBe("");
  });
});

describe("extractRequisitionId", () => {
  it.each([
    // Workday — token returned VERBATIM including posting-instance suffix ("-1").
    [
      "https://bmo.wd3.myworkdayjobs.com/External/job/San-Ramon-CA-USA/Software-Developer--Summer-2026--Internship----10-weeks_R260002319-1",
      "R260002319-1",
    ],
    [
      "https://haier.wd3.myworkdayjobs.com/ge_appliances/job/USA-Louisville-KY/Software-Engineering-Co-op-Spring-2027_REQ-24832",
      "REQ-24832",
    ],
    [
      "https://equifax.wd5.myworkdayjobs.com/UR_External/job/USA---Georgia---Alpharetta---30005/Data---Analytics-Intern_J00171081",
      "J00171081",
    ],
    // Greenhouse (both hosts).
    ["https://boards.greenhouse.io/point72/jobs/8389431002", "8389431002"],
    ["https://job-boards.greenhouse.io/ginkgobioworks/jobs/5033167007", "5033167007"],
    // Lever.
    [
      "https://jobs.lever.co/hermeus/51378fa0-0327-45fd-9420-b6e7d8b56440",
      "51378fa0-0327-45fd-9420-b6e7d8b56440",
    ],
    // Ashby (uuid mid-path).
    [
      "https://jobs.ashbyhq.com/dryft/3f1c261d-9b65-412b-9f17-34b8968bdd78/application",
      "3f1c261d-9b65-412b-9f17-34b8968bdd78",
    ],
    // AMD-style careers site; query params ignored.
    ["https://careers.amd.com/jobs/91866?icims=1", "91866"],
    // iCIMS.
    ["https://careers-foo.icims.com/jobs/12345/software-intern/job", "12345"],
    // Greenhouse EMBED on the company's own host: every requisition shares one
    // path and differs only in ?gh_jid=. Three real EquipmentShare postings
    // parsed to null here and were merged into one row, hiding two roles.
    ["https://www.equipmentshare.com/careers/openings/?gh_jid=8188474", "8188474"],
    ["https://www.equipmentshare.com/careers/openings/?gh_jid=8188802", "8188802"],
    // Trailing slash absent, extra params present.
    ["https://www.optiver.com/join-us/jobs/8402114002/?gh_jid=8402114002", "8402114002"],
    ["https://example.test/careers?gh_jid=42&utm_source=x", "42"],
  ])("%j → %j", (url, expected) => {
    expect(extractRequisitionId(url)).toBe(expected);
  });

  it.each([
    // Aggregators and unknown shapes → null.
    "https://jobright.ai/jobs/info/abc123",
    "https://www.google.com/careers/jobs",
    "https://bmo.wd3.myworkdayjobs.com/External/job/San-Ramon-CA-USA/No-Req-Suffix-Here",
    "https://jobs.lever.co/hermeus/not-a-uuid",
    "not a url",
    // gh_jid must look like a Greenhouse id; a junk value is not an identity.
    "https://example.test/careers?gh_jid=not-a-number",
    "https://example.test/careers?gh_jid=",
  ])("%j → null", (url) => {
    expect(extractRequisitionId(url)).toBeNull();
  });
});

describe("titleSimilarity", () => {
  it("gives 1.0 for identical normalized titles", () => {
    expect(titleSimilarity("Software Engineer Intern", "Software Engineer Intern")).toBe(1);
    // Season noise normalizes away → identical.
    expect(
      titleSimilarity("Software Engineer Intern (Summer 2027)", "Software Engineer Intern"),
    ).toBe(1);
  });

  it("scores morphological variants high (>= 0.85)", () => {
    const s = titleSimilarity("Software Engineer Intern", "Software Engineering Intern");
    expect(s).toBeGreaterThanOrEqual(0.85);
    expect(s).toBeLessThan(1);
  });

  it("scores different disciplines low (<= 0.5)", () => {
    expect(
      titleSimilarity("Software Engineer Intern", "Hardware Engineer Intern"),
    ).toBeLessThanOrEqual(0.5);
  });

  it("is symmetric", () => {
    const a = "Software Engineer Intern";
    const b = "Software Engineering Intern";
    expect(titleSimilarity(a, b)).toBeCloseTo(titleSimilarity(b, a), 10);
  });

  it("ignores word order", () => {
    expect(
      titleSimilarity("Software Engineer Intern", "Intern, Software Engineer"),
    ).toBe(1);
  });

  it("returns 0 when only one side is empty after normalization", () => {
    expect(titleSimilarity("(Summer 2027)", "Software Engineer Intern")).toBe(0);
  });
});
