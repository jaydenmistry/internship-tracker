import { describe, expect, it } from "vitest";
import {
  addContactHref,
  companiesOf,
  EMPTY_FILTERS,
  filterContacts,
  linkedinHref,
  mailtoHref,
  toggle,
} from "@/app/network/state";
import type { ContactRow } from "@/lib/networking/contacts";

function row(overrides: Partial<ContactRow> = {}): ContactRow {
  return {
    id: "c1",
    name: "Sam Lee",
    companyId: "co1",
    company: "Stripe",
    companyKey: "stripe",
    title: "University Recruiter",
    kind: "RECRUITER",
    email: "sam@stripe.com",
    linkedinUrl: null,
    status: "NOT_CONTACTED",
    doNotContact: false,
    nextFollowUpAt: null,
    lastMessageAt: null,
    updatedAt: "2026-09-20T12:00:00.000Z",
    ...overrides,
  };
}

const rows = [
  row(),
  row({ id: "c2", name: "Ana Diaz", company: "Ramp", companyKey: "ramp", title: "SWE", kind: "ENGINEER", email: null }),
  row({ id: "c3", name: "Lee Park", company: null, companyKey: null, title: null, kind: "ALUMNI", status: "REPLIED" }),
];

describe("filterContacts", () => {
  it("returns everything with no filters", () => {
    expect(filterContacts(rows, EMPTY_FILTERS)).toHaveLength(3);
  });

  it("matches every search term somewhere, case-insensitively", () => {
    const ids = (q: string) => filterContacts(rows, { ...EMPTY_FILTERS, query: q }).map((r) => r.id);
    expect(ids("lee")).toEqual(["c1", "c3"]);
    expect(ids("STRIPE recruiter")).toEqual(["c1"]);
    expect(ids("ramp recruiter")).toEqual([]);
    expect(ids("sam@stripe")).toEqual(["c1", "c3"]);
  });

  it("filters to one company exactly by normalized key", () => {
    expect(filterContacts(rows, { ...EMPTY_FILTERS, companyKey: "stripe" }).map((r) => r.id)).toEqual(["c1"]);
    expect(filterContacts(rows, { ...EMPTY_FILTERS, companyKey: "strip" })).toEqual([]);
  });

  it("offers each company with contacts once, A→Z, with counts", () => {
    const withDupe = [...rows, row({ id: "c4", name: "Kim", company: "Stripe", companyKey: "stripe" })];
    expect(companiesOf(withDupe)).toEqual([
      { key: "ramp", name: "Ramp", count: 1 },
      { key: "stripe", name: "Stripe", count: 2 },
    ]);
    expect(companiesOf(rows, "gone").map((o) => o.key)).toEqual(["gone", "ramp", "stripe"]);
  });

  it("filters by kind and status, empty meaning any", () => {
    expect(filterContacts(rows, { ...EMPTY_FILTERS, kinds: new Set(["ENGINEER", "ALUMNI"]) }).map((r) => r.id)).toEqual([
      "c2",
      "c3",
    ]);
    expect(filterContacts(rows, { ...EMPTY_FILTERS, statuses: new Set(["REPLIED"]) }).map((r) => r.id)).toEqual(["c3"]);
  });

  it("toggle returns a new set without mutating the old one", () => {
    const a = new Set(["X"]);
    const b = toggle(a, "Y");
    expect([...b]).toEqual(["X", "Y"]);
    expect([...toggle(b, "X")]).toEqual(["Y"]);
    expect([...a]).toEqual(["X"]);
  });
});

describe("links", () => {
  it("re-validates LinkedIn URLs on render", () => {
    expect(linkedinHref("https://www.linkedin.com/in/sam")).toBe("https://www.linkedin.com/in/sam");
    expect(linkedinHref("javascript:alert(1)")).toBeNull();
    expect(linkedinHref(null)).toBeNull();
  });

  it("builds a mailto only for a plain address", () => {
    expect(mailtoHref("sam@stripe.com")).toBe("mailto:sam@stripe.com");
    expect(mailtoHref("sam@stripe.com?bcc=x@evil.test")).toBeNull();
    expect(mailtoHref("sam@stripe.com\nBcc: x@evil.test")).toBeNull();
    expect(mailtoHref("javascript:alert(1)")).toBeNull();
    expect(mailtoHref(null)).toBeNull();
  });

  it("encodes the company in the add-contact link", () => {
    expect(addContactHref("AT&T Labs")).toBe("/network?add=1&company=AT%26T%20Labs");
  });
});
