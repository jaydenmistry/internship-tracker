import { describe, expect, it } from "vitest";

import { loadScoringConfig, type ScoringConfig } from "@/lib/scoring/config";
import { scoreListing, type ScoringInput } from "@/lib/scoring/engine";

const { config } = loadScoringConfig();

/** Fixed clock for every test — the engine never reads the wall clock. */
const NOW = new Date("2026-09-18T12:00:00.000Z");

function daysBefore(days: number): Date {
  return new Date(NOW.getTime() - days * 86_400_000);
}
function daysAfter(days: number): Date {
  return new Date(NOW.getTime() + days * 86_400_000);
}

function listing(overrides: Partial<ScoringInput> = {}): ScoringInput {
  return {
    title: "Software Engineer Intern",
    category: "Software",
    postingText: null,
    locations: ["Austin, TX"],
    countries: ["US"],
    remote: false,
    degrees: [],
    sponsorship: null,
    postedAt: null,
    deadline: null,
    likelyClosed: false,
    terms: ["Summer 2027"],
    company: { name: "Acme", faangPlus: false, tierOverride: null },
    ...overrides,
  };
}

function clone(cfg: ScoringConfig): ScoringConfig {
  return JSON.parse(JSON.stringify(cfg)) as ScoringConfig;
}

const evidenceText = (input: ScoringInput, key: string): string =>
  scoreListing(input, config, NOW).breakdown[key].evidence.join(" | ");

// ---------------------------------------------------------------------------
// techFit
// ---------------------------------------------------------------------------

describe("techFit", () => {
  const cases: Array<[name: string, text: string, expected: string[], forbidden: string[]]> = [
    ["Go matches golang prose", "We write services in Go and Rust.", ["Go"], []],
    ["Go does not match Google", "Intern at Google in Chicago.", [], ["Go"]],
    ["Go does not match Chicago", "Our Chicago office.", [], ["Go"]],
    ["Go does not match 'go-to-market'", "Support our go-to-market team.", [], ["Go"]],
    ["golang matches", "Experience with Golang preferred.", ["Go"], []],
    ["C and C++ both match in C/C++", "Strong C/C++ skills.", ["C", "C++"], []],
    ["C++ alone does not match bare C", "Systems work in C++.", ["C++"], ["C ("]],
    ["C# does not match C", "Build services in C#.", [], ["C ("]],
    ["React matches", "Our frontend uses React.", ["React"], []],
    ["React does not match reactive", "We build reactive pipelines.", [], ["React"]],
    ["Next.js matches", "Next.js app router experience.", ["Next.js"], ["React ("]],
    ["case-insensitive", "KUBERNETES, docker, AwS, LINUX", ["Kubernetes", "Docker", "AWS", "Linux"], []],
    [
      "distributed systems and backend",
      "Work on distributed systems and back-end microservices.",
      ["distributed systems", "backend"],
      [],
    ],
    [
      "cybersecurity",
      "Threat detection and application security tooling.",
      ["cybersecurity"],
      [],
    ],
    ["infrastructure", "Own our infrastructure and CI/CD pipelines.", ["infrastructure"], []],
    ["no matches", "Assist with filing and scheduling.", [], ["Go", "Python"]],
  ];

  it.each(cases)("%s", (_name, text, expected, forbidden) => {
    const evidence = evidenceText(listing({ postingText: text }), "techFit");
    for (const label of expected) expect(evidence).toContain(label);
    for (const label of forbidden) expect(evidence).not.toContain(label);
  });

  it("notes thin signal when there is no posting text", () => {
    const evidence = evidenceText(listing({ postingText: null }), "techFit");
    expect(evidence).toContain(config.techFit.titleOnlyNote);
  });

  it("does not note thin signal when posting text is present", () => {
    const evidence = evidenceText(listing({ postingText: "Go and Kubernetes." }), "techFit");
    expect(evidence).not.toContain(config.techFit.titleOnlyNote);
  });

  it("matches on title + category when there is no posting text", () => {
    const evidence = evidenceText(
      listing({ title: "Python Backend Engineer Intern", postingText: null }),
      "techFit",
    );
    expect(evidence).toContain("Python");
    expect(evidence).toContain("backend");
  });

  it("caps at maxPoints when every skill hits", () => {
    const text =
      "Go, Golang, TypeScript, React, Next.js, Python, C++, C, Docker, Kubernetes, AWS, Linux, " +
      "distributed systems, cybersecurity, back-end, infrastructure.";
    const { breakdown } = scoreListing(listing({ postingText: text }), config, NOW);
    expect(breakdown.techFit.points).toBe(config.techFit.maxPoints);
  });
});

// ---------------------------------------------------------------------------
// roleType
// ---------------------------------------------------------------------------

describe("roleType", () => {
  const max = config.roleType.maxPoints;
  const cases: Array<[title: string, fraction: number, label: string]> = [
    ["Backend Software Engineer Intern", 1.0, "backend"],
    ["Infrastructure Engineering Intern", 1.0, "backend"],
    ["Platform Engineer Intern", 1.0, "backend"],
    ["Site Reliability Engineering Intern", 1.0, "backend"],
    ["Distributed Systems Intern", 1.0, "backend"],
    ["Cybersecurity Analyst Intern", 1.0, "security"],
    ["Software Engineer Intern", 0.8, "general software"],
    ["Full-Stack Developer Intern", 0.8, "general software"],
    ["Machine Learning Intern", 0.6, "data / machine learning"],
    ["Mobile Engineer Intern (iOS)", 0.55, "mobile"],
    ["Frontend Software Engineer Intern", 0.5, "frontend"],
    ["QA Engineering Intern", 0.35, "QA"],
    ["IT Help Desk Intern", 0.1, "IT / help desk"],
    ["Systems Administrator Intern", 0.1, "IT / help desk"],
  ];

  it.each(cases)("%s → %s of max", (title, fraction, label) => {
    const { breakdown } = scoreListing(listing({ title, category: null }), config, NOW);
    expect(breakdown.roleType.points).toBeCloseTo(fraction * max, 5);
    expect(breakdown.roleType.evidence.join(" ")).toContain(label);
  });

  it("falls back to the unmatched bucket", () => {
    const { breakdown } = scoreListing(
      listing({ title: "Summer Intern", category: null, postingText: null }),
      config,
      NOW,
    );
    expect(breakdown.roleType.points).toBeCloseTo(config.roleType.unmatched.fraction * max, 5);
    expect(breakdown.roleType.evidence).toEqual([config.roleType.unmatched.label]);
  });

  it("falls back to posting text when the title says nothing", () => {
    const { breakdown } = scoreListing(
      listing({
        title: "Summer Intern",
        category: null,
        postingText: "You will work on our backend services.",
      }),
      config,
      NOW,
    );
    expect(breakdown.roleType.points).toBeCloseTo(max, 5);
    expect(breakdown.roleType.evidence.join(" ")).toContain("posting text matched");
  });

  it("does not let a generic title outrank a specific one", () => {
    const frontend = scoreListing(
      listing({ title: "Software Engineer Intern, Frontend", category: null }),
      config,
      NOW,
    );
    expect(frontend.breakdown.roleType.points).toBeCloseTo(0.5 * max, 5);
  });
});

// ---------------------------------------------------------------------------
// companyTier
// ---------------------------------------------------------------------------

describe("companyTier", () => {
  const max = config.companyTier.maxPoints;

  it("gives FAANG+ the top tier", () => {
    const { breakdown } = scoreListing(
      listing({ company: { name: "Meta", faangPlus: true, tierOverride: null } }),
      config,
      NOW,
    );
    expect(breakdown.companyTier.points).toBe(max);
    expect(breakdown.companyTier.evidence.join(" ")).toContain("FAANG+");
  });

  it("lets a manual tier override beat the FAANG+ flag", () => {
    const { breakdown } = scoreListing(
      listing({ company: { name: "Meta", faangPlus: true, tierOverride: 4 } }),
      config,
      NOW,
    );
    expect(breakdown.companyTier.points).toBeCloseTo(0.3 * max, 5);
    expect(breakdown.companyTier.evidence.join(" ")).toContain("manual tier override");
  });

  it("promotes a non-FAANG company via an override", () => {
    const { breakdown } = scoreListing(
      listing({ company: { name: "Jane Street", faangPlus: false, tierOverride: 1 } }),
      config,
      NOW,
    );
    expect(breakdown.companyTier.points).toBe(max);
  });

  it("uses the default tier otherwise", () => {
    const { breakdown } = scoreListing(listing(), config, NOW);
    expect(breakdown.companyTier.points).toBeCloseTo(0.5 * max, 5);
    expect(breakdown.companyTier.evidence.join(" ")).toContain("default tier");
  });

  it("degrades gracefully for a tier the config does not define", () => {
    const { breakdown } = scoreListing(
      listing({ company: { name: "Weird", faangPlus: false, tierOverride: 9 } }),
      config,
      NOW,
    );
    expect(breakdown.companyTier.points).toBeCloseTo(
      config.companyTier.unknownTierFraction * max,
      5,
    );
    expect(breakdown.companyTier.evidence.join(" ")).toContain("not defined in config");
  });
});

// ---------------------------------------------------------------------------
// location
// ---------------------------------------------------------------------------

describe("location", () => {
  const max = config.location.maxPoints;
  const cases: Array<[name: string, overrides: Partial<ScoringInput>, fraction: number]> = [
    ["Atlanta", { locations: ["Atlanta, GA"], countries: ["US"] }, 1.0],
    ["Atlanta suburb", { locations: ["Alpharetta, GA"], countries: ["US"] }, 1.0],
    ["US remote", { locations: [], countries: ["US"], remote: true }, 1.0],
    ["hub — NYC", { locations: ["New York, NY"], countries: ["US"] }, 0.8],
    ["hub — Bay Area", { locations: ["Mountain View, CA"], countries: ["US"] }, 0.8],
    ["hub — Seattle", { locations: ["Seattle, WA"], countries: ["US"] }, 0.8],
    ["rest of US", { locations: ["Louisville, KY"], countries: ["US"] }, 0.5],
    ["non-US", { locations: ["Toronto, ON"], countries: ["CA"] }, 0.0],
    ["unknown", { locations: [], countries: [], remote: false }, 0.3],
    [
      "best of several wins",
      { locations: ["Toronto, ON", "Atlanta, GA"], countries: ["CA", "US"] },
      1.0,
    ],
    [
      "hub beats rest-of-US",
      { locations: ["Louisville, KY", "Austin, TX"], countries: ["US"] },
      0.8,
    ],
  ];

  it.each(cases)("%s", (_name, overrides, fraction) => {
    const { breakdown } = scoreListing(listing(overrides), config, NOW);
    expect(breakdown.location.points).toBeCloseTo(fraction * max, 5);
  });
});

// ---------------------------------------------------------------------------
// freshness
// ---------------------------------------------------------------------------

describe("freshness", () => {
  const max = config.freshness.maxPoints;
  const halfLife = config.freshness.halfLifeDays;

  const cases: Array<[name: string, postedAt: Date | null, fraction: number]> = [
    ["posted now", NOW, 1.0],
    ["posted one half-life ago", daysBefore(halfLife), 0.5],
    ["posted two half-lives ago", daysBefore(halfLife * 2), 0.25],
    ["posted four half-lives ago", daysBefore(halfLife * 4), 0.0625],
    ["missing postedAt", null, config.freshness.missingPostedAtFraction],
    ["future postedAt clamps to fresh", daysAfter(3), 1.0],
  ];

  it.each(cases)("%s", (_name, postedAt, fraction) => {
    const { breakdown } = scoreListing(listing({ postedAt }), config, NOW);
    expect(breakdown.freshness.points).toBeCloseTo(fraction * max, 2);
  });

  it("is monotonic: newer always scores at least as high", () => {
    const newer = scoreListing(listing({ postedAt: daysBefore(2) }), config, NOW);
    const older = scoreListing(listing({ postedAt: daysBefore(30) }), config, NOW);
    expect(newer.breakdown.freshness.points).toBeGreaterThan(older.breakdown.freshness.points);
  });
});

// ---------------------------------------------------------------------------
// deadlineUrgency
// ---------------------------------------------------------------------------

describe("deadlineUrgency", () => {
  const max = config.deadlineUrgency.maxPoints;
  const window = config.deadlineUrgency.windowDays;

  const cases: Array<[name: string, deadline: Date | null, fraction: number]> = [
    ["inside the window", daysAfter(3), 1.0],
    ["exactly at the window edge", daysAfter(window), 1.0],
    ["just outside the window", daysAfter(window + 0.5), 0.0],
    ["far outside the window", daysAfter(60), 0.0],
    ["past deadline is not urgency", daysBefore(1), 0.0],
    ["missing deadline (the common case)", null, 0.0],
  ];

  it.each(cases)("%s", (_name, deadline, fraction) => {
    const { breakdown } = scoreListing(listing({ deadline }), config, NOW);
    expect(breakdown.deadlineUrgency.points).toBeCloseTo(fraction * max, 5);
  });

  it("labels a past deadline as passed, not urgent", () => {
    const evidence = evidenceText(listing({ deadline: daysBefore(5) }), "deadlineUrgency");
    expect(evidence).toContain("passed");
  });
});

// ---------------------------------------------------------------------------
// Disqualifiers
// ---------------------------------------------------------------------------

describe("disqualifiers — advanced degree", () => {
  const advancedOnly: Array<[degree: string, reason: string]> = [
    ["Master's", "requires Master's degree"],
    ["MS", "requires Master's degree"],
    ["PhD", "requires PhD"],
    ["MBA", "requires MBA"],
    ["JD", "requires JD"],
    ["MD", "requires MD"],
    ["DDS", "requires DDS"],
    ["DO", "requires DO"],
    ["DVM", "requires DVM"],
    ["PharmD", "requires PharmD"],
  ];

  it.each(advancedOnly)("degrees: [%s] is disqualifying", (degree, reason) => {
    const result = scoreListing(listing({ degrees: [degree] }), config, NOW);
    expect(result.disqualified).toBe(true);
    expect(result.disqualifyReasons).toContain(reason);
    expect(result.ruleScore).toBe(0);
  });

  it("keeps the full breakdown when disqualified", () => {
    const result = scoreListing(
      listing({ degrees: ["PhD"], locations: ["Atlanta, GA"], postedAt: NOW }),
      config,
      NOW,
    );
    expect(result.ruleScore).toBe(0);
    expect(Object.keys(result.breakdown).sort()).toEqual([
      "companyTier",
      "deadlineUrgency",
      "freshness",
      "location",
      "roleType",
      "techFit",
    ]);
    expect(result.breakdown.location.points).toBe(config.location.maxPoints);
  });

  it("does NOT disqualify when a bachelor's is also accepted", () => {
    // Simplify lists the degrees a posting ACCEPTS: ["Bachelor's","Master's","MBA","PhD"]
    // is an undergrad-eligible posting, not a grad-only one.
    const result = scoreListing(
      listing({ degrees: ["Bachelor's", "Master's", "MBA", "PhD"] }),
      config,
      NOW,
    );
    expect(result.disqualified).toBe(false);
  });

  const textCases: Array<[text: string, disqualified: boolean]> = [
    ["A Master's degree is required for this role.", true],
    ["Masters required.", true],
    ["PhD required.", true],
    ["Ph.D. degree is required.", true],
    ["MBA required.", true],
    ["Candidates must be currently pursuing a Master's or PhD in Computer Science.", true],
    ["Open only to graduate students.", true],
    ["Must be enrolled in a Master's program.", true],
    ["Graduate degree required.", true],
    ["Currently pursuing a Bachelor's or Master's degree in Computer Science.", false],
    ["Bachelor's or Master's preferred.", false],
    ["Bachelor's, Master's, or PhD in a technical field.", false],
    ["Pursuing a Bachelor's degree in Computer Science.", false],
    ["Master's degree is a plus.", false],
    ["You will work with engineers who hold PhDs.", false],
  ];

  it.each(textCases)("posting text %j → disqualified=%s", (text, disqualified) => {
    const result = scoreListing(listing({ postingText: text }), config, NOW);
    expect(result.disqualified).toBe(disqualified);
  });

  it("lets structured degrees[] outrank a degree regex over prose", () => {
    // The source says undergrads are accepted; a regex hit in the description
    // (often a different track's requirement) must not override that.
    const withRequirement = scoreListing(
      listing({
        degrees: ["Bachelor's", "Master's"],
        postingText: "This role requires a Master's degree.",
      }),
      config,
      NOW,
    );
    expect(withRequirement.disqualified).toBe(false);

    const multiTrack = scoreListing(
      listing({
        degrees: ["Bachelor's", "Master's"],
        postingText:
          "Bachelor's degree in CS required.\nMaster's degree required for the ML track.",
      }),
      config,
      NOW,
    );
    expect(multiTrack.disqualified).toBe(false);
  });

  it("still reads posting text when degrees[] is empty or grad-only", () => {
    expect(
      scoreListing(
        listing({ degrees: [], postingText: "A Master's degree is required." }),
        config,
        NOW,
      ).disqualified,
    ).toBe(true);
    expect(
      scoreListing(
        listing({ degrees: ["Master's"], postingText: "Great team." }),
        config,
        NOW,
      ).disqualified,
    ).toBe(true);
  });

  it("treats hyphen and bullet list items as separate sentences", () => {
    // ATS text is often one line of bullets with no sentence punctuation.
    const text =
      "Requirements: - Currently pursuing a Bachelor's or Master's degree in CS " +
      "- PhD required for the research track";
    const result = scoreListing(listing({ postingText: text }), config, NOW);
    expect(result.disqualified).toBe(true);
    expect(result.disqualifyReasons).toContain("requires PhD");
  });

  it("scopes an exemption to its own sentence", () => {
    const text =
      "We hire Bachelor's or Master's students for other teams. For this role a PhD is required.";
    const result = scoreListing(listing({ postingText: text }), config, NOW);
    expect(result.disqualified).toBe(true);
    expect(result.disqualifyReasons).toContain("requires PhD");
  });
});

describe("disqualifiers — work authorization", () => {
  const cases: Array<[name: string, overrides: Partial<ScoringInput>, disqualified: boolean]> = [
    ["Toronto only", { locations: ["Toronto, ON"], countries: ["CA"] }, true],
    ["London only", { locations: ["London, United Kingdom"], countries: ["UK"] }, true],
    ["Dublin + Berlin", { locations: ["Dublin, Ireland", "Berlin, Germany"], countries: ["IE", "DE"] }, true],
    [
      "Toronto + Atlanta",
      { locations: ["Toronto, ON", "Atlanta, GA"], countries: ["CA", "US"] },
      false,
    ],
    ["US only", { locations: ["Austin, TX"], countries: ["US"] }, false],
    ["remote-only", { locations: [], countries: [], remote: true }, false],
    ["remote flagged with a Canadian office", { locations: ["Toronto, ON"], countries: ["CA"], remote: true }, false],
    ["no countries derived", { locations: ["Somewhere"], countries: [] }, false],
  ];

  it.each(cases)("%s → disqualified=%s", (_name, overrides, disqualified) => {
    const result = scoreListing(listing(overrides), config, NOW);
    expect(result.disqualified).toBe(disqualified);
    if (disqualified) {
      expect(result.disqualifyReasons).toContain("Canada/UK/EU work authorization");
    }
  });
});

describe("disqualifiers — closed and sponsorship", () => {
  it("disqualifies a likely-closed posting", () => {
    const result = scoreListing(listing({ likelyClosed: true }), config, NOW);
    expect(result.disqualified).toBe(true);
    expect(result.disqualifyReasons).toContain("posting likely closed");
    expect(result.ruleScore).toBe(0);
  });

  it("never disqualifies on sponsorship alone", () => {
    const result = scoreListing(
      listing({ sponsorship: "Does Not Offer Sponsorship" }),
      config,
      NOW,
    );
    expect(result.disqualified).toBe(false);
  });

  it("collects every applicable reason", () => {
    const result = scoreListing(
      listing({
        degrees: ["PhD"],
        locations: ["Toronto, ON"],
        countries: ["CA"],
        likelyClosed: true,
      }),
      config,
      NOW,
    );
    expect(result.disqualifyReasons).toEqual([
      "requires PhD",
      "Canada/UK/EU work authorization",
      "posting likely closed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Weighted sum: bounds, weight-config edges, determinism
// ---------------------------------------------------------------------------

describe("weighted sum", () => {
  const perfect = listing({
    title: "Backend Infrastructure Engineer Intern",
    category: "Software",
    postingText:
      "Build distributed systems in Go and Python. Our back-end runs on Kubernetes, Docker and AWS " +
      "with Linux hosts, TypeScript tooling, C++ services, infrastructure as code and application " +
      "security reviews.",
    locations: ["Atlanta, GA"],
    countries: ["US"],
    remote: true,
    postedAt: NOW,
    deadline: daysAfter(2),
    degrees: ["Bachelor's"],
    company: { name: "Meta", faangPlus: true, tierOverride: 1 },
  });

  const barren = listing({
    title: "IT Help Desk Intern",
    category: null,
    postingText: "Assist staff with password resets and printer issues.",
    locations: ["Toronto, ON"],
    countries: ["CA"],
    remote: true,
    postedAt: daysBefore(3650),
    deadline: null,
    company: { name: "Nowhere", faangPlus: false, tierOverride: 5 },
  });

  it("reaches exactly 100 when every component maxes out", () => {
    const result = scoreListing(perfect, config, NOW);
    expect(result.disqualified).toBe(false);
    expect(result.ruleScore).toBe(100);
  });

  it("stays at or above 0 when nothing hits", () => {
    const result = scoreListing(barren, config, NOW);
    expect(result.disqualified).toBe(false);
    expect(result.ruleScore).toBeGreaterThanOrEqual(0);
    expect(result.ruleScore).toBeLessThan(15);
  });

  it("is deterministic across repeated calls", () => {
    const a = scoreListing(perfect, config, NOW);
    const b = scoreListing(perfect, config, NOW);
    expect(b).toEqual(a);
  });

  it("ignores a component whose weight key is missing", () => {
    const withoutTechFit = clone(config);
    delete withoutTechFit.weights.techFit;
    const input = listing({ postingText: "Assist with scheduling.", postedAt: NOW });
    const withWeight = scoreListing(input, config, NOW).ruleScore;
    const without = scoreListing(input, withoutTechFit, NOW).ruleScore;
    expect(without).toBeGreaterThan(withWeight);
    // The component is still computed and reported for the UI.
    expect(scoreListing(input, withoutTechFit, NOW).breakdown.techFit).toBeDefined();
  });

  it("treats a zero weight like a missing one", () => {
    const zeroed = clone(config);
    zeroed.weights.techFit = 0;
    const missing = clone(config);
    delete missing.weights.techFit;
    const input = listing({ postingText: "Assist with scheduling.", postedAt: NOW });
    expect(scoreListing(input, zeroed, NOW).ruleScore).toBe(
      scoreListing(input, missing, NOW).ruleScore,
    );
  });

  it("returns 0 when every weight is zero, without dividing by zero", () => {
    const allZero = clone(config);
    allZero.weights = {
      techFit: 0,
      roleType: 0,
      companyTier: 0,
      location: 0,
      freshness: 0,
      deadlineUrgency: 0,
    };
    const result = scoreListing(listing({ postedAt: NOW }), allZero, NOW);
    expect(result.ruleScore).toBe(0);
    expect(Number.isNaN(result.ruleScore)).toBe(false);
  });

  it("follows the documented formula", () => {
    const input = listing({
      title: "Backend Engineer Intern",
      postingText: "Go, Kubernetes and AWS.",
      locations: ["Atlanta, GA"],
      postedAt: daysBefore(config.freshness.halfLifeDays),
      deadline: daysAfter(2),
    });
    const { breakdown, ruleScore } = scoreListing(input, config, NOW);
    let weighted = 0;
    let weightSum = 0;
    for (const [name, weight] of Object.entries(config.weights)) {
      const c = breakdown[name];
      weighted += (weight as number) * (c.points / c.max);
      weightSum += weight as number;
    }
    expect(ruleScore).toBe(Math.round((100 * weighted) / weightSum));
  });
});

// ---------------------------------------------------------------------------
// Golden listings — exact scores against the SHIPPED config.
// These break loudly when config/scoring.json changes. That is their job:
// re-derive the expectations by hand before updating them.
// ---------------------------------------------------------------------------

describe("golden listings", () => {
  it("golden 1 — FAANG+ backend internship in Atlanta with rich posting text", () => {
    const input = listing({
      title: "Software Engineer Intern, Backend Infrastructure",
      category: "Software",
      postingText:
        "You will build distributed systems in Go, deploy them on Kubernetes with Docker, " +
        "and operate them on AWS over Linux hosts.",
      locations: ["Atlanta, GA"],
      countries: ["US"],
      postedAt: daysBefore(7),
      company: { name: "Meta", faangPlus: true, tierOverride: null },
    });
    const result = scoreListing(input, config, NOW);

    // techFit: Go 12 + distributed systems 12 + Kubernetes 8 + AWS 8 + Docker 7
    //          + Linux 6 = 53 (no "back-end"/"microservices" wording in the text)
    expect(result.breakdown.techFit.points).toBe(53);
    expect(result.breakdown.roleType.points).toBe(100); // backend / infrastructure
    expect(result.breakdown.companyTier.points).toBe(100); // FAANG+ → tier 1
    expect(result.breakdown.location.points).toBe(100); // Atlanta metro
    expect(result.breakdown.freshness.points).toBe(70.71); // 0.5^(7/14)
    expect(result.breakdown.deadlineUrgency.points).toBe(0);
    // 30(.53) + 22(1) + 14(1) + 16(1) + 12(.7071) + 6(0) = 15.9+22+14+16+8.49 = 76.39
    expect(result.ruleScore).toBe(76);
    expect(result.disqualified).toBe(false);
  });

  it("golden 2 — title-only mid-tier listing outside the hubs", () => {
    const input = listing({
      title: "Software Engineering Co-op Spring 2027",
      category: "Software",
      postingText: null,
      locations: ["Louisville, KY"],
      countries: ["US"],
      postedAt: daysBefore(28),
      degrees: ["Bachelor's", "Master's", "MBA", "PhD"],
      company: { name: "GE Appliances", faangPlus: false, tierOverride: null },
    });
    const result = scoreListing(input, config, NOW);

    expect(result.breakdown.techFit.points).toBe(0);
    expect(result.breakdown.techFit.evidence).toEqual([
      config.techFit.noMatchNote,
      config.techFit.titleOnlyNote,
    ]);
    expect(result.breakdown.roleType.points).toBe(80); // general SWE
    expect(result.breakdown.companyTier.points).toBe(50); // default tier 3
    expect(result.breakdown.location.points).toBe(50); // rest of US
    expect(result.breakdown.freshness.points).toBe(25); // two half-lives
    // 30(0) + 22(.8) + 14(.5) + 16(.5) + 12(.25) + 6(0) = 17.6+7+8+3 = 35.6
    expect(result.ruleScore).toBe(36);
    expect(result.disqualified).toBe(false);
  });

  it("golden 3 — remote security internship closing this week", () => {
    const input = listing({
      title: "Cybersecurity Engineering Intern",
      category: "Cybersecurity",
      postingText:
        "Join our application security team. You will write Python tooling, review Linux " +
        "infrastructure, and help with threat detection.",
      locations: [],
      countries: ["US"],
      remote: true,
      postedAt: daysBefore(2),
      deadline: daysAfter(4),
      company: { name: "Cloudflare", faangPlus: false, tierOverride: 2 },
    });
    const result = scoreListing(input, config, NOW);

    // techFit: cybersecurity 10 + infrastructure 10 + Python 8 + Linux 6 = 34
    expect(result.breakdown.techFit.points).toBe(34);
    expect(result.breakdown.roleType.points).toBe(100); // security
    expect(result.breakdown.companyTier.points).toBe(75); // tier 2 override
    expect(result.breakdown.location.points).toBe(100); // US-remote
    expect(result.breakdown.freshness.points).toBe(90.57); // 0.5^(2/14)
    expect(result.breakdown.deadlineUrgency.points).toBe(100);
    // 30(.34) + 22(1) + 14(.75) + 16(1) + 12(.9057) + 6(1) = 10.2+22+10.5+16+10.87+6 = 75.57
    expect(result.ruleScore).toBe(76);
  });

  it("golden 4 — Canada-only ML listing: disqualified, breakdown preserved", () => {
    const input = listing({
      title: "Machine Learning Intern",
      category: "AI/ML/Data",
      postingText: "Work on ML models in Python.",
      locations: ["Toronto, ON"],
      countries: ["CA"],
      postedAt: daysBefore(14),
      company: { name: "Cohere", faangPlus: false, tierOverride: null },
    });
    const result = scoreListing(input, config, NOW);

    expect(result.ruleScore).toBe(0);
    expect(result.disqualified).toBe(true);
    expect(result.disqualifyReasons).toEqual(["Canada/UK/EU work authorization"]);
    expect(result.breakdown.techFit.points).toBe(8); // Python
    expect(result.breakdown.roleType.points).toBe(60); // data / ML
    expect(result.breakdown.location.points).toBe(0); // outside the US
    expect(result.breakdown.freshness.points).toBe(50);
  });
});
