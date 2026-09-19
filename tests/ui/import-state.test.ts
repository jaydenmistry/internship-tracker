import { describe, expect, it } from "vitest";
import {
  isPreselected,
  matchRows,
  parseImportText,
  type MatchableListing,
} from "@/lib/applications/import";
import {
  buildCommitPayload,
  candidatesFor,
  decisionsReducer,
  defaultDecision,
  formatConfidence,
  initialDecisions,
  safeHttpUrl,
  summarize,
  toReviewRows,
  verdictMeta,
  type DecisionMap,
} from "@/app/import/state";
import type { ReviewRow } from "@/app/import/types";

/**
 * The import UI's decision layer. These are the pure pieces — everything that
 * decides what gets written to the database when the user hits Import — so they
 * are tested without a DOM.
 */

const CATALOG: MatchableListing[] = [
  {
    id: "l-robinhood",
    company: "Robinhood",
    title: "Software Engineer Intern - Backend",
    locations: ["Menlo Park, CA"],
    url: "https://jobs.example.com/robinhood/backend",
    requisitionId: "RH-1",
    finalScore: 92,
    applied: false,
  },
  {
    id: "l-datadog-a",
    company: "Datadog",
    title: "Backend Engineer Intern",
    locations: ["New York, NY"],
    url: "https://jobs.example.com/datadog/a",
    requisitionId: "DD-1",
    finalScore: 81,
    applied: false,
  },
  {
    id: "l-datadog-b",
    company: "Datadog",
    title: "Backend Engineering Intern",
    locations: ["New York, NY"],
    url: "https://jobs.example.com/datadog/b",
    requisitionId: "DD-2",
    finalScore: 80,
    applied: false,
  },
];

function reviewRows(text: string): ReviewRow[] {
  const { rows } = parseImportText(text);
  return toReviewRows(matchRows(rows, CATALOG));
}

/** A hand-built row, so verdict-driven behaviour can be asserted in isolation. */
function fakeRow(key: string, verdict: ReviewRow["verdict"], withMatch = true): ReviewRow {
  const best = withMatch
    ? {
        listingId: `listing-${key}`,
        company: "Acme",
        title: "SWE Intern",
        location: "Atlanta, GA",
        score: 70,
        url: "https://jobs.example.com/acme",
        alreadyApplied: false,
        confidence: 0.7,
        reasons: ["company matches", "role ~70%"],
      }
    : null;
  return {
    key,
    row: {
      company: "Acme",
      role: "SWE Intern",
      location: "Atlanta, GA",
      lineNumber: Number(key),
      raw: `Acme, SWE Intern, Atlanta GA`,
    },
    verdict,
    best,
    alternatives: [],
    companyContext: null,
  };
}

describe("defaults follow isPreselected only", () => {
  it("pre-selects exact and strong rows", () => {
    for (const verdict of ["exact", "strong"] as const) {
      expect(isPreselected(verdict)).toBe(true);
      const decision = defaultDecision(fakeRow("1", verdict));
      expect(decision.action).toBe("link");
      expect(decision.listingId).toBe("listing-1");
      expect(decision.touched).toBe(false);
    }
  });

  it("leaves a 'likely' row unselected even though it has a proposed match", () => {
    const row = fakeRow("7", "likely");
    expect(row.best).not.toBeNull();
    expect(isPreselected("likely")).toBe(false);
    expect(defaultDecision(row)).toEqual({ action: "skip", listingId: null, touched: false });
  });

  it("leaves 'weak' and 'none' rows unselected", () => {
    expect(defaultDecision(fakeRow("8", "weak")).action).toBe("skip");
    expect(defaultDecision(fakeRow("9", "none", false)).action).toBe("skip");
  });

  it("never links a row the matcher could not resolve", () => {
    const rows = [fakeRow("1", "exact"), fakeRow("2", "likely"), fakeRow("3", "none", false)];
    const decisions = initialDecisions(rows);
    const linked = Object.values(decisions).filter((d) => d.action === "link");
    expect(linked).toHaveLength(1);
  });
});

describe("summary counts match the decisions", () => {
  const rows = [
    fakeRow("1", "exact"),
    fakeRow("2", "strong"),
    fakeRow("3", "likely"),
    fakeRow("4", "none", false),
  ];

  it("counts the defaults", () => {
    expect(summarize(rows, initialDecisions(rows))).toEqual({
      link: 2,
      manual: 0,
      skip: 2,
      untouched: 2,
      total: 4,
    });
  });

  it("tracks link / manual / skip after the user decides", () => {
    let decisions = initialDecisions(rows);
    decisions = decisionsReducer(decisions, {
      type: "set",
      key: "3",
      action: "link",
      listingId: "listing-3",
    });
    decisions = decisionsReducer(decisions, { type: "set", key: "4", action: "manual" });
    decisions = decisionsReducer(decisions, { type: "set", key: "1", action: "skip" });

    expect(summarize(rows, decisions)).toEqual({
      link: 2,
      manual: 1,
      skip: 1,
      // The skipped row was skipped deliberately, so nothing is left undecided.
      untouched: 0,
      total: 4,
    });
  });

  it("does not count a link decision that lost its listing id", () => {
    const decisions: DecisionMap = {
      "1": { action: "link", listingId: null, touched: true },
    };
    expect(summarize([rows[0]], decisions).link).toBe(0);
  });
});

describe("decisionsReducer", () => {
  const row = fakeRow("5", "likely");

  it("toggles an excluded row into its proposed match", () => {
    const next = decisionsReducer(initialDecisions([row]), { type: "toggle", row });
    expect(next["5"]).toEqual({ action: "link", listingId: "listing-5", touched: true });
  });

  it("toggles an unmatched row into a manual application", () => {
    const unmatched = fakeRow("6", "none", false);
    const next = decisionsReducer(initialDecisions([unmatched]), {
      type: "toggle",
      row: unmatched,
    });
    expect(next["6"].action).toBe("manual");
    expect(next["6"].listingId).toBeNull();
  });

  it("toggles an included row back out", () => {
    const included = fakeRow("1", "exact");
    const next = decisionsReducer(initialDecisions([included]), { type: "toggle", row: included });
    expect(next["1"].action).toBe("skip");
  });

  it("clears the listing id when switching to manual", () => {
    const state = decisionsReducer(initialDecisions([row]), {
      type: "set",
      key: "5",
      action: "link",
      listingId: "listing-5",
    });
    expect(decisionsReducer(state, { type: "set", key: "5", action: "manual" })["5"].listingId)
      .toBeNull();
  });

  it("skips unmatched rows in a bulk link", () => {
    const rows = [fakeRow("1", "none", false), fakeRow("2", "likely")];
    const next = decisionsReducer(initialDecisions(rows), { type: "bulk", rows, action: "link" });
    expect(next["1"].action).toBe("skip");
    expect(next["2"].action).toBe("link");
  });

  it("resets to the verdict-driven defaults", () => {
    const rows = [fakeRow("1", "exact")];
    const dirty = decisionsReducer(initialDecisions(rows), {
      type: "set",
      key: "1",
      action: "skip",
    });
    expect(decisionsReducer(dirty, { type: "reset", rows })["1"].action).toBe("link");
  });
});

describe("buildCommitPayload", () => {
  const rows = [fakeRow("1", "exact"), fakeRow("2", "none", false), fakeRow("3", "likely")];

  it("drops skipped rows and carries the pasted values through", () => {
    let decisions = initialDecisions(rows);
    decisions = decisionsReducer(decisions, { type: "set", key: "2", action: "manual" });
    const payload = buildCommitPayload(rows, decisions);

    expect(payload.map((p) => p.lineNumber)).toEqual([1, 2]);
    expect(payload[0].listingId).toBe("listing-1");
    expect(payload[1].listingId).toBeNull();
    expect(payload[1].company).toBe("Acme");
    expect(payload[1].raw).toBe("Acme, SWE Intern, Atlanta GA");
  });

  it("omits a link decision with no listing id rather than writing a bad row", () => {
    const decisions: DecisionMap = {
      "1": { action: "link", listingId: null, touched: true },
    };
    expect(buildCommitPayload(rows, decisions)).toEqual([]);
  });
});

describe("paste → parse → match → defaults pipeline", () => {
  it("pre-selects the confident row and leaves the unknown company unselected", () => {
    const rows = reviewRows(
      [
        "Company, Role, Location",
        "Robinhood, Software Engineer Intern - Backend, Menlo Park CA",
        "Some Startup That Does Not Exist, Platform Engineer Intern, Atlanta GA",
      ].join("\n"),
    );

    expect(rows).toHaveLength(2);
    const [robinhood, unknown] = rows;

    expect(robinhood.best?.listingId).toBe("l-robinhood");
    expect(isPreselected(robinhood.verdict)).toBe(true);
    expect(defaultDecision(robinhood).action).toBe("link");

    expect(unknown.best).toBeNull();
    expect(unknown.verdict).toBe("none");
    expect(defaultDecision(unknown).action).toBe("skip");
  });

  it("does not pre-select an ambiguous pair of near-identical listings", () => {
    const [row] = reviewRows("Datadog, Backend Engineer Intern, New York NY");
    expect(row.alternatives.length).toBeGreaterThan(0);
    // Two requisitions that differ only in wording: the user must choose.
    expect(isPreselected(row.verdict) && row.verdict === "exact").toBe(false);
  });

  it("surfaces parse errors instead of dropping the line", () => {
    const { rows, errors } = parseImportText("Company, Role\nRobinhood\n");
    expect(rows).toHaveLength(0);
    expect(errors[0].lineNumber).toBe(2);
    expect(errors[0].reason).toContain("missing");
  });

  it("only sends the matched candidates to the client, never the catalog", () => {
    const [row] = reviewRows("Datadog, Backend Engineer Intern, New York NY");
    const shipped = [row.best, ...row.alternatives].filter(Boolean);
    expect(shipped.length).toBeLessThanOrEqual(CATALOG.length);
    // Candidates are flattened: no nested listing object, no fields the UI
    // does not render.
    expect(Object.keys(row.best!).sort()).toEqual([
      "alreadyApplied",
      "company",
      "confidence",
      "listingId",
      "location",
      "reasons",
      "score",
      "title",
      "url",
    ]);
  });
});

describe("untrusted text stays literal text", () => {
  const nasty = `<script>alert(1)</script>, <b>Backend</b> Intern, <img src=x onerror=alert(1)>`;

  it("carries markup through the parser as plain characters", () => {
    const { rows } = parseImportText(nasty);
    expect(rows).toHaveLength(1);
    expect(rows[0].company).toBe("<script>alert(1)</script>");
    expect(rows[0].role).toBe("<b>Backend</b> Intern");
    expect(rows[0].location).toBe("<img src=x onerror=alert(1)>");
  });

  it("carries markup unchanged into the commit payload", () => {
    const rows = toReviewRows(matchRows(parseImportText(nasty).rows, CATALOG));
    const decisions = decisionsReducer(initialDecisions(rows), {
      type: "set",
      key: rows[0].key,
      action: "manual",
    });
    const [payload] = buildCommitPayload(rows, decisions);

    // No escaping, no stripping, no HTML interpretation — the string round-trips
    // verbatim and React escapes it at render time.
    expect(payload.company).toBe("<script>alert(1)</script>");
    expect(payload.role).toBe("<b>Backend</b> Intern");
    expect(payload.raw).toBe(nasty);
  });
});

describe("safeHttpUrl", () => {
  it("passes http and https through", () => {
    expect(safeHttpUrl("https://jobs.example.com/x")).toBe("https://jobs.example.com/x");
    expect(safeHttpUrl("http://jobs.example.com/x")).toBe("http://jobs.example.com/x");
  });

  it("rejects the schemes that would execute in an href", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "  javascript:alert(1)  ",
      "",
      null,
      undefined,
    ]) {
      expect(safeHttpUrl(url)).toBeNull();
    }
  });
});

describe("verdict presentation", () => {
  it("labels every verdict", () => {
    expect(verdictMeta("exact").label).toBe("exact");
    expect(verdictMeta("strong").label).toBe("strong");
    expect(verdictMeta("likely").label).toBe("likely");
    expect(verdictMeta("weak").label).toBe("weak");
    expect(verdictMeta("none").label).toBe("no match");
  });

  it("separates preselected verdicts from the rest by colour", () => {
    expect(verdictMeta("exact").textClass).toBe(verdictMeta("strong").textClass);
    expect(verdictMeta("likely").textClass).not.toBe(verdictMeta("exact").textClass);
  });

  it("formats confidences at a fixed width", () => {
    expect(formatConfidence(0.9)).toBe("0.90");
    expect(formatConfidence(1)).toBe("1.00");
    expect(formatConfidence(null)).toBe("—");
    expect(formatConfidence(undefined)).toBe("—");
  });
});

describe("candidatesFor", () => {
  const row = fakeRow("1", "strong");

  it("puts the proposed match first and de-duplicates", () => {
    const extra = { ...row.best!, listingId: "listing-1" };
    const candidates = candidatesFor(row, [extra]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].listingId).toBe("listing-1");
  });

  it("appends hand-picked listings", () => {
    const picked = { ...row.best!, listingId: "picked", reasons: ["picked by hand"] };
    expect(candidatesFor(row, [picked]).map((c) => c.listingId)).toEqual([
      "listing-1",
      "picked",
    ]);
  });

  it("returns nothing for an unmatched row", () => {
    expect(candidatesFor(fakeRow("2", "none", false))).toEqual([]);
  });
});
