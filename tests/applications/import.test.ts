import { describe, expect, it } from "vitest";
import {
  isPreselected,
  matchRows,
  parseImportText,
  type MatchableListing,
} from "@/lib/applications/import";

/** Shaped after real rows in the catalog. */
function listing(overrides: Partial<MatchableListing> = {}): MatchableListing {
  return {
    id: "l1",
    company: "Robinhood",
    title: "Software Engineer Intern - Backend",
    locations: ["Menlo Park, CA"],
    url: "https://boards.greenhouse.io/robinhood/jobs/700001",
    requisitionId: "700001",
    finalScore: 75,
    applied: false,
    ...overrides,
  };
}

describe("parseImportText", () => {
  it("parses a CSV with a header in any column order", () => {
    const { rows, errors } = parseImportText(
      [
        "Role,Company,Location,Req ID",
        "Software Engineer Intern - Backend,Robinhood,Menlo Park CA,700001",
        "Backend Engineer Intern,Datadog,New York NY,",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      company: "Robinhood",
      role: "Software Engineer Intern - Backend",
      location: "Menlo Park CA",
      requisitionId: "700001",
    });
    expect(rows[1].requisitionId).toBeUndefined();
  });

  it("parses positional rows with no header", () => {
    const { rows } = parseImportText("Stripe, Backend Intern, Seattle WA");
    expect(rows[0]).toMatchObject({ company: "Stripe", role: "Backend Intern", location: "Seattle WA" });
  });

  it("handles tab, pipe and dash separated pastes", () => {
    expect(parseImportText("Stripe\tBackend Intern\tNYC").rows[0]).toMatchObject({
      company: "Stripe",
      role: "Backend Intern",
    });
    expect(parseImportText("Stripe | Backend Intern | NYC").rows[0]).toMatchObject({
      company: "Stripe",
      role: "Backend Intern",
    });
    expect(parseImportText("Stripe — Backend Intern — NYC").rows[0]).toMatchObject({
      company: "Stripe",
      role: "Backend Intern",
    });
  });

  it("keeps commas inside quoted fields", () => {
    const { rows } = parseImportText('Acme,"Engineer, Backend",NYC');
    expect(rows[0].role).toBe("Engineer, Backend");
  });

  it("recognizes a URL wherever it appears, and derives nothing else from it", () => {
    const { rows } = parseImportText(
      "Robinhood, SWE Intern, Menlo Park, https://boards.greenhouse.io/robinhood/jobs/700001",
    );
    expect(rows[0].url).toBe("https://boards.greenhouse.io/robinhood/jobs/700001");
    expect(rows[0].location).toBe("Menlo Park");
  });

  it("reports unusable lines instead of dropping them silently", () => {
    const { rows, errors } = parseImportText(["Stripe, Backend Intern", "", "JustACompanyName"].join("\n"));
    expect(rows).toHaveLength(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ lineNumber: 3, raw: "JustACompanyName" });
    expect(errors[0].reason).toMatch(/role/i);
  });

  it("skips blank and commented lines", () => {
    const { rows, errors } = parseImportText(["# my applications", "", "Stripe, Backend Intern"].join("\n"));
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("treats markup in pasted text as literal data", () => {
    const { rows } = parseImportText("<script>alert(1)</script>, <b>Intern</b>, NYC");
    expect(rows[0].company).toBe("<script>alert(1)</script>");
    expect(rows[0].role).toBe("<b>Intern</b>");
  });
});

describe("matchRows", () => {
  const catalog = [
    listing(),
    listing({
      id: "l2",
      company: "Amazon",
      title: "Software Development Engineer Intern - Summer 2027",
      locations: ["Seattle, WA"],
      url: "https://amazon.jobs/en/jobs/900002",
      requisitionId: "900002",
      finalScore: 76,
    }),
    listing({
      id: "l3",
      company: "Datadog",
      title: "Backend Engineer Intern",
      locations: ["New York, NY"],
      url: "https://boards.greenhouse.io/datadog/jobs/800003",
      requisitionId: "800003",
      finalScore: 61,
    }),
  ];

  const match = (text: string) => matchRows(parseImportText(text).rows, catalog)[0];

  it("returns an exact verdict for a URL match, beating any fuzzy signal", () => {
    const r = match("Totally Different Name, Unrelated Role, https://boards.greenhouse.io/robinhood/jobs/700001");
    expect(r.verdict).toBe("exact");
    expect(r.best?.listing.id).toBe("l1");
    expect(r.best?.confidence).toBe(1);
    expect(r.best?.reasons.join(" ")).toMatch(/url/i);
  });

  it("matches on requisition id when the company is spelled differently", () => {
    const r = match("Robinhood Markets Inc., SWE Intern Backend, Menlo Park CA, 700001");
    expect(r.verdict).toBe("exact");
    expect(r.best?.listing.id).toBe("l1");
  });

  it("strongly matches a plain company + role + location row", () => {
    const r = match("Robinhood, Software Engineer Intern - Backend, Menlo Park CA");
    expect(r.best?.listing.id).toBe("l1");
    expect(["strong", "exact"]).toContain(r.verdict);
    expect(r.best!.confidence).toBeGreaterThan(0.85);
  });

  it("tolerates a legal-suffix difference in the company name", () => {
    const r = match("Datadog Inc., Backend Engineer Intern, New York NY");
    expect(r.best?.listing.id).toBe("l3");
    expect(r.best!.confidence).toBeGreaterThan(0.8);
  });

  it("returns no match for a company that isn't in the catalog", () => {
    const r = match("Some Startup That Does Not Exist, Platform Engineer Intern, Atlanta GA");
    expect(r.verdict).toBe("none");
    expect(r.best).toBeNull();
    // Nothing known about the company at all — different from the case below.
    expect(r.companyContext).toBeNull();
  });

  it("does not match a different role at the same company", () => {
    const r = match("Datadog, Recruiting Coordinator, New York NY");
    expect(r.verdict).toBe("none");
  });

  it("distinguishes 'company not tracked' from 'company tracked, no role matches'", () => {
    // The real Datadog case: the company IS in the catalog, but the role the
    // user applied to isn't — which means the posting probably closed or was
    // never carried by the sources, and is worth going to check.
    const r = match("Datadog, Recruiting Coordinator, New York NY");
    expect(r.best).toBeNull();
    expect(r.companyContext).not.toBeNull();
    expect(r.companyContext!.company).toBe("Datadog");
    expect(r.companyContext!.roleCount).toBe(1);
    expect(r.companyContext!.sampleTitles).toContain("Backend Engineer Intern");
  });

  it("reports company context even when a role does match", () => {
    const r = match("Datadog, Backend Engineer Intern, New York NY");
    expect(r.companyContext?.company).toBe("Datadog");
  });

  it("demotes an ambiguous match so the user has to choose", () => {
    const twins = [
      listing({ id: "a", title: "Software Engineer Intern", requisitionId: "111", url: "https://x.test/111" }),
      listing({ id: "b", title: "Software Engineer Intern", requisitionId: "222", url: "https://x.test/222" }),
    ];
    const [r] = matchRows(parseImportText("Robinhood, Software Engineer Intern, Menlo Park CA").rows, twins);
    // Two identical-confidence candidates must never auto-link.
    expect(isPreselected(r.verdict)).toBe(false);
    expect(r.alternatives.length).toBeGreaterThan(0);
  });

  it("offers alternatives so a wrong guess can be corrected in place", () => {
    const r = match("Robinhood, Software Engineer Intern, Menlo Park CA");
    expect(r.best).not.toBeNull();
    expect(Array.isArray(r.alternatives)).toBe(true);
  });

  it("only pre-selects proven or strong matches", () => {
    expect(isPreselected("exact")).toBe(true);
    expect(isPreselected("strong")).toBe(true);
    expect(isPreselected("likely")).toBe(false);
    expect(isPreselected("weak")).toBe(false);
    expect(isPreselected("none")).toBe(false);
  });

  it("penalizes a location mismatch without discarding the candidate", () => {
    const same = match("Datadog, Backend Engineer Intern, New York NY");
    const diff = match("Datadog, Backend Engineer Intern, Dublin Ireland");
    expect(diff.best?.listing.id).toBe("l3");
    expect(diff.best!.confidence).toBeLessThan(same.best!.confidence);
  });
});
