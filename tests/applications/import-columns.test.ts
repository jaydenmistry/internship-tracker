import { describe, expect, it } from "vitest";
import { parseAppliedDate, parseImportText, parseStatus } from "@/lib/applications/import";

describe("per-row Status / Applied / Notes columns", () => {
  it("reads them from a header in any order", () => {
    const { rows, errors } = parseImportText(
      ["Notes,Status,Company,Applied,Role", "follow up,OA,Stripe,2026-09-10,Backend Intern"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({
      company: "Stripe",
      role: "Backend Intern",
      status: "OA",
      notes: "follow up",
    });
    expect(rows[0].appliedAt?.slice(0, 10)).toBe("2026-09-10");
  });

  it("rejects an unknown status rather than silently defaulting to Applied", () => {
    const { rows, errors } = parseImportText(
      ["Company,Role,Status", "Stripe,Backend Intern,Interveiw"].join("\n"),
    );
    expect(rows).toEqual([]);
    expect(errors[0].reason).toMatch(/unknown status "Interveiw"/);
  });

  it("rejects an impossible date instead of rolling it over", () => {
    const { rows, errors } = parseImportText(
      ["Company,Role,Applied", "Stripe,Backend Intern,2026-02-31"].join("\n"),
    );
    expect(rows).toEqual([]);
    expect(errors[0].reason).toMatch(/applied date/);
  });

  it("leaves the columns absent when the header doesn't have them", () => {
    const { rows } = parseImportText(["Company,Role", "Stripe,Backend Intern"].join("\n"));
    expect(rows[0].status).toBeUndefined();
    expect(rows[0].appliedAt).toBeUndefined();
    expect(rows[0].notes).toBeUndefined();
  });
});

describe("parseStatus", () => {
  it.each([
    ["APPLIED", "APPLIED"],
    ["PHONE_SCREEN", "PHONE_SCREEN"],
    ["phone screen", "PHONE_SCREEN"],
    ["Phone-Screen", "PHONE_SCREEN"],
    ["Online Assessment", "OA"],
    ["oa", "OA"],
    ["onsite", "INTERVIEW"],
    ["Rejected", "REJECTED"],
    ["NOT_APPLIED", "NOT_APPLIED"],
  ])("%s → %s", (raw, expected) => {
    expect(parseStatus(raw)).toBe(expected);
  });

  it("returns null for anything unrecognized", () => {
    expect(parseStatus("ghosted")).toBeNull();
    expect(parseStatus("")).toBeNull();
  });
});

describe("parseAppliedDate", () => {
  it("parses YYYY-MM-DD as that calendar day, not shifted by timezone", () => {
    expect(parseAppliedDate("2026-09-15")?.slice(0, 10)).toBe("2026-09-15");
  });
  it("rejects garbage and rollover dates", () => {
    expect(parseAppliedDate("not a date")).toBeNull();
    expect(parseAppliedDate("2026-13-01")).toBeNull();
    expect(parseAppliedDate("2026-02-30")).toBeNull();
  });
});

describe("delimiter is chosen once, from the first record", () => {
  it("does not re-split a comma CSV on a pipe inside a field", () => {
    const { rows, errors } = parseImportText(
      ["Company,Role,Notes", "Stripe,Backend Intern,asked A | B"].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(rows[0]).toMatchObject({ company: "Stripe", role: "Backend Intern", notes: "asked A | B" });
  });

  it("still handles a pipe paste whose fields contain commas", () => {
    const { rows } = parseImportText("Acme | Engineer, Backend | NYC");
    expect(rows[0]).toMatchObject({ company: "Acme", role: "Engineer, Backend", location: "NYC" });
  });

  it("treats a stray inch mark as text, not a runaway quote swallowing later lines", () => {
    const { rows } = parseImportText(['Acme, 6" Display Intern, NYC', "Stripe, Backend Intern, SF"].join("\n"));
    expect(rows).toHaveLength(2);
    expect(rows[1].company).toBe("Stripe");
  });
});
