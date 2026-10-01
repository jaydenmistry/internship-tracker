import { describe, expect, it } from "vitest";
import { findDuplicates, IMPORT_MAX_ROWS, parseContactImport } from "@/lib/networking/import";
import { initialSelection, toggleRow } from "@/app/network/import/state";

// The shape LinkedIn's "Connections.csv" export actually has: a notes preamble,
// then First Name / Last Name / URL / Email Address / Company / Position / Connected On.
const LINKEDIN_EXPORT = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing."

First Name,Last Name,URL,Email Address,Company,Position,Connected On
Ada,Example,https://www.linkedin.com/in/ada-example,,Stripe,University Recruiter,12 Jan 2024
Grace,Sample,https://www.linkedin.com/in/grace-sample,grace@example.com,"Datadog, Inc.",Software Engineer,03 Mar 2025
`;

describe("parseContactImport", () => {
  it("reads LinkedIn's Connections export as is", () => {
    const r = parseContactImport(LINKEDIN_EXPORT);
    expect(r.linkedInExport).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.contact)).toEqual([
      {
        name: "Ada Example",
        company: "Stripe",
        title: "University Recruiter",
        kind: "RECRUITER",
        email: null,
        linkedinUrl: "https://www.linkedin.com/in/ada-example",
        howMet: "Connected on LinkedIn, Jan 2024",
        notes: null,
        doNotContact: false,
      },
      expect.objectContaining({
        name: "Grace Sample",
        company: "Datadog, Inc.",
        kind: "ENGINEER",
        email: "grace@example.com",
        howMet: "Connected on LinkedIn, Mar 2025",
      }),
    ]);
  });

  it("takes headers in any order, explicit kinds, and keeps quoted commas and newlines", () => {
    const r = parseContactImport(
      'Notes,Kind,Email,Name,Company\n"Line one, still notes\nline two",alumni,sam@example.com,Sam Lee,Ramp\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0].contact).toMatchObject({
      name: "Sam Lee",
      company: "Ramp",
      kind: "ALUMNI",
      email: "sam@example.com",
      notes: "Line one, still notes\nline two",
    });
  });

  it("guesses a kind from the title only when there's no kind column", () => {
    const r = parseContactImport("Name,Title\nA,Engineering Manager\nB,Talent Partner\nC,Student\n");
    expect(r.rows.map((x) => x.contact.kind)).toEqual(["HIRING_MANAGER", "RECRUITER", "OTHER"]);
  });

  it("reports bad rows with their line number and keeps the good ones", () => {
    const r = parseContactImport(
      "Name,Company,Email,Kind\nGood One,Stripe,good@example.com,engineer\n,Stripe,,\nBad Email,Ramp,not-an-email,\nOdd Kind,Ramp,,astronaut\nKanji Co,株式会社,,\n",
    );
    expect(r.rows.map((x) => x.contact.name)).toEqual(["Good One"]);
    expect(r.errors.map((e) => [e.lineNumber, e.reason])).toEqual([
      [3, expect.stringMatching(/name/)],
      [4, expect.stringMatching(/email/)],
      [5, 'unknown kind "astronaut"'],
      [6, expect.stringMatching(/no Latin letters/)],
    ]);
  });

  it("drops a non-LinkedIn URL instead of failing the row", () => {
    const r = parseContactImport("Name,URL\nA,javascript:alert(1)\nB,https://evil.example/in/x\n");
    expect(r.rows.map((x) => x.contact.linkedinUrl)).toEqual([null, null]);
  });

  it("undoes the CSV export's formula guard", () => {
    const r = parseContactImport("Name,Notes\n'=Not a formula,'+1 follow up\n");
    expect(r.rows[0].contact).toMatchObject({ name: "=Not a formula", notes: "+1 follow up" });
  });

  it("requires a header naming the person", () => {
    const r = parseContactImport("Ada Example, Stripe, Recruiter\n");
    expect(r.rows).toEqual([]);
    expect(r.errors[0].reason).toMatch(/no header row/);
  });

  it("stops at the row limit and says so", () => {
    const body = Array.from({ length: IMPORT_MAX_ROWS + 5 }, (_, i) => `Person ${i}`).join("\n");
    const r = parseContactImport(`Name\n${body}\n`);
    expect(r.rows).toHaveLength(IMPORT_MAX_ROWS);
    expect(r.errors.at(-1)?.reason).toMatch(/stopped at 2000 rows/);
  });
});

describe("findDuplicates", () => {
  const rows = parseContactImport(
    [
      "Name,Company,Email,LinkedIn",
      "Ada Example,Stripe,ADA@example.com,",
      "Bob Other,Ramp,,https://www.linkedin.com/in/bob/",
      "Cy Same,Stripe Inc.,,",
      "Dee New,Datadog,dee@example.com,",
      "Dee Again,Datadog,dee@example.com,",
    ].join("\n"),
  ).rows;
  const existing = [
    { id: "e1", name: "Ada E.", companyKey: "stripe", email: "ada@example.com", linkedinUrl: null },
    { id: "e2", name: "Robert", companyKey: "ramp", email: null, linkedinUrl: "https://linkedin.com/in/BOB" },
    { id: "e3", name: "cy  same", companyKey: "stripe", email: null, linkedinUrl: null },
  ];
  const dupes = findDuplicates(rows, existing);

  it("matches saved contacts by email, LinkedIn profile, or name at the same company", () => {
    expect(dupes.get(2)).toMatchObject({ kind: "existing", contactId: "e1", reason: "same email" });
    expect(dupes.get(3)).toMatchObject({ kind: "existing", contactId: "e2", reason: "same LinkedIn profile" });
    expect(dupes.get(4)).toMatchObject({ kind: "existing", contactId: "e3", reason: "same name and company" });
  });

  it("flags a repeat of an earlier row, not the first occurrence", () => {
    expect(dupes.has(5)).toBe(false);
    expect(dupes.get(6)).toMatchObject({ kind: "earlier-row", lineNumber: 5, reason: "same email" });
  });

  it("review starts with duplicates unticked", () => {
    const sel = initialSelection(rows.map((r) => ({ lineNumber: r.lineNumber, duplicate: dupes.get(r.lineNumber) ?? null })));
    expect([...sel]).toEqual([5]);
    expect([...toggleRow(sel, 2)].sort()).toEqual([2, 5]);
    expect([...toggleRow(sel, 5)]).toEqual([]);
  });
});

describe("review fixes", () => {
  it("keeps columns aligned when a tab-separated row starts with a blank cell", () => {
    const r = parseContactImport("Kind\tName\tCompany\n\tAda Example\tStripe\nalumni\tGrace\tRamp\n");
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => [x.contact.name, x.contact.company, x.contact.kind])).toEqual([
      ["Ada Example", "Stripe", "OTHER"],
      ["Grace", "Ramp", "ALUMNI"],
    ]);
  });

  it("keeps a real leading apostrophe; strips only this app's formula guard", () => {
    const r = parseContactImport("Name,Notes\nO'Brien,'Til next week\nX,'=SUM(1)\n");
    expect(r.rows.map((x) => x.contact.notes)).toEqual(["'Til next week", "=SUM(1)"]);
  });

  it("reads LinkedIn's 'Connected On' date by hand (no time-zone drift)", () => {
    const r = parseContactImport("First Name,Last Name,Connected On\nA,B,01 Jan 2024\nC,D,someday\n");
    expect(r.rows.map((x) => x.contact.howMet)).toEqual([
      "Connected on LinkedIn, Jan 2024",
      "Connected on LinkedIn (someday)",
    ]);
  });

  it("guesses hiring manager only for people who manage engineers", () => {
    const r = parseContactImport(
      "Name,Title\nA,Product Manager\nB,Tech Lead\nC,Software Engineering Manager\nD,Lead Software Engineer\nE,Account Manager\n",
    );
    expect(r.rows.map((x) => x.contact.kind)).toEqual(["OTHER", "OTHER", "HIRING_MANAGER", "ENGINEER", "OTHER"]);
  });

  it("a row flagged by one key still claims its other keys for later rows", () => {
    const rows = parseContactImport(
      "Name,Email,LinkedIn\nAda,ada@example.com,https://www.linkedin.com/in/ada\nAda Again,,https://www.linkedin.com/in/ada/\n",
    ).rows;
    const dupes = findDuplicates(rows, [
      { id: "e1", name: "Ada", companyKey: null, email: "ada@example.com", linkedinUrl: null },
    ]);
    expect(dupes.get(2)).toMatchObject({ kind: "existing", contactId: "e1" });
    expect(dupes.get(3)).toMatchObject({ kind: "earlier-row", lineNumber: 2, reason: "same LinkedIn profile" });
  });
});
