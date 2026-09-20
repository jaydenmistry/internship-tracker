import { describe, expect, it } from "vitest";
import {
  CSV_COLUMNS,
  applicationsToCsv,
  neutralizeFormula,
  restoreFormulaPrefix,
} from "@/lib/applications/csv";
import { parseImportText } from "@/lib/applications/import";
import type { TrackerApplication } from "@/lib/applications/tracker";

function app(overrides: Partial<TrackerApplication> = {}): TrackerApplication {
  return {
    id: "a1",
    listingId: "l1",
    company: "Robinhood",
    role: "Software Engineer Intern - Backend",
    location: "Menlo Park, CA",
    status: "APPLIED",
    appliedAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-15T00:00:00.000Z",
    lastEventAt: null,
    notes: null,
    url: "https://boards.greenhouse.io/robinhood/jobs/700001",
    requisitionId: "700001",
    score: 75,
    rank: 4,
    likelyClosed: false,
    ...overrides,
  };
}

describe("formula-injection guard", () => {
  it.each(["=HYPERLINK(\"http://evil\")", "+1+2", "-2+3", "@SUM(A1)", "\tcmd", "\rcmd"])(
    "neutralizes a cell starting with a formula trigger: %j",
    (value) => {
      expect(neutralizeFormula(value).startsWith("'")).toBe(true);
    },
  );

  it("leaves ordinary text alone", () => {
    for (const v of ["Robinhood", "Software Engineer", "Menlo Park, CA", "5 years"]) {
      expect(neutralizeFormula(v)).toBe(v);
    }
  });

  it("neutralizes a formula hidden behind leading whitespace", () => {
    // A spreadsheet reads " =x" as text, but a CSV reader that trims hands the
    // formula straight back to one.
    for (const v of [" =cmd()", "   +1+1", "\t@SUM(A1)"]) {
      expect(neutralizeFormula(v).startsWith("'")).toBe(true);
    }
  });

  it("escapes a value that already starts with an apostrophe, so it survives", () => {
    expect(restoreFormulaPrefix(neutralizeFormula("'=notmine"))).toBe("'=notmine");
    expect(restoreFormulaPrefix(neutralizeFormula("'quoted"))).toBe("'quoted");
  });

  it("round-trips exactly: restore undoes neutralize", () => {
    for (const v of ["=cmd()", "+x", "-y", "@z", "plain", " =spaced", "'already quoted text", "O'Brien"]) {
      expect(restoreFormulaPrefix(neutralizeFormula(v))).toBe(v);
    }
  });

  it("never lets a scraped formula reach the file unescaped", () => {
    const csv = applicationsToCsv([app({ company: '=HYPERLINK("http://evil","click")' })]);
    const dataLine = csv.split("\r\n")[1];
    // The first cell must start with the apostrophe guard (inside quotes, since it has a comma).
    expect(dataLine.startsWith(`"'=HYPERLINK`)).toBe(true);
  });
});

describe("applicationsToCsv", () => {
  it("writes the header the importer understands", () => {
    const [header] = applicationsToCsv([]).split("\r\n");
    expect(header).toBe(CSV_COLUMNS.join(","));
  });

  it("quotes fields containing commas, quotes and newlines (RFC 4180)", () => {
    const csv = applicationsToCsv([
      app({ notes: 'Asked about "on-call", referral from Sam\nfollow up Friday' }),
    ]);
    expect(csv).toContain('"Asked about ""on-call"", referral from Sam\nfollow up Friday"');
  });

  it("writes only the date part of appliedAt", () => {
    const csv = applicationsToCsv([app()]);
    expect(csv).toContain(",2026-09-15,");
  });
});

describe("export → import round trip", () => {
  it("restores company, role, location, status, date, req id, URL and notes", () => {
    const original = [
      app({ status: "INTERVIEW", notes: "Onsite on the 30th" }),
      app({
        id: "a2",
        listingId: null,
        company: "Some Startup, Inc.",
        role: "Platform Engineer Intern",
        location: "Atlanta, GA",
        status: "REJECTED",
        appliedAt: "2026-08-01T00:00:00.000Z",
        url: null,
        requisitionId: null,
        notes: null,
      }),
    ];
    const { rows, errors } = parseImportText(applicationsToCsv(original));

    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      company: "Robinhood",
      role: "Software Engineer Intern - Backend",
      location: "Menlo Park, CA",
      status: "INTERVIEW",
      requisitionId: "700001",
      url: "https://boards.greenhouse.io/robinhood/jobs/700001",
      notes: "Onsite on the 30th",
    });
    expect(rows[0].appliedAt?.slice(0, 10)).toBe("2026-09-15");
    expect(rows[1]).toMatchObject({
      company: "Some Startup, Inc.",
      status: "REJECTED",
    });
    expect(rows[1].appliedAt?.slice(0, 10)).toBe("2026-08-01");
  });

  it("keeps a multi-line note intact instead of splitting the row", () => {
    const note = "line one\nline two, with a comma\nline three | with a pipe";
    const { rows, errors } = parseImportText(applicationsToCsv([app({ notes: note })]));
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0].notes).toBe(note);
  });

  it("restores a formula-looking value exactly, without the guard apostrophe", () => {
    const { rows } = parseImportText(applicationsToCsv([app({ role: "=Backend Intern" })]));
    expect(rows[0].role).toBe("=Backend Intern");
  });
});
