import { describe, expect, it } from "vitest";
import {
  addContactHref,
  companiesOf,
  dueWhen,
  emptyMessageForm,
  messageFormToPayload,
  sortContacts,
  withEvent,
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
    pendingSince: null,
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

describe("sortContacts", () => {
  const r = [
    row({ id: "a", updatedAt: "2026-09-01T00:00:00Z", nextFollowUpAt: null, pendingSince: "2026-08-01T00:00:00Z" }),
    row({ id: "b", updatedAt: "2026-09-03T00:00:00Z", nextFollowUpAt: "2026-09-30T04:00:00Z", pendingSince: null }),
    row({ id: "c", updatedAt: "2026-09-02T00:00:00Z", nextFollowUpAt: "2026-09-26T04:00:00Z", pendingSince: "2026-09-01T00:00:00Z" }),
  ];
  it.each([
    ["recent", ["b", "c", "a"]],
    ["next", ["c", "b", "a"]],
    ["pending", ["a", "c", "b"]],
  ] as const)("%s", (sort, ids) => {
    expect(sortContacts(r, sort).map((x) => x.id)).toEqual(ids);
  });
});

describe("dueWhen (in the server's zone)", () => {
  const NY = "America/New_York";
  const now = Date.parse("2026-09-25T16:00:00Z"); // Fri noon NY
  it("labels today, tomorrow, later and overdue by calendar day", () => {
    expect(dueWhen("2026-09-25T04:00:00Z", now, NY)).toEqual({ text: "due today", overdue: false });
    expect(dueWhen("2026-09-26T04:00:00Z", now, NY)).toEqual({ text: "due tomorrow", overdue: false });
    expect(dueWhen("2026-10-02T04:00:00Z", now, NY).text).toBe("due Fri, Oct 2");
    expect(dueWhen("2026-09-22T04:00:00Z", now, NY)).toEqual({ text: "overdue 3d (Tue, Sep 22)", overdue: true });
  });
  it("renders a New-York midnight as that day even for a zone west of it", () => {
    // Midnight EDT is 21:00 the day before in Los Angeles; shown in NY it's Oct 2.
    expect(dueWhen("2026-10-02T04:00:00Z", now, NY).text).toBe("due Fri, Oct 2");
  });
});

describe("log message form", () => {
  it("narrows the channel to what the event allows", () => {
    const f = emptyMessageForm("OUT:COLD");
    expect(f.channel).toBe("EMAIL");
    expect(withEvent(f, "OUT:CONNECT_NOTE").channel).toBe("LINKEDIN");
    expect(withEvent(f, "OUT:MEETING").channel).toBe("IN_PERSON");
    expect(withEvent({ ...f, channel: "LINKEDIN" }, "OUT:FOLLOW_UP").channel).toBe("LINKEDIN");
  });

  it("builds the payload, dropping a subject off-email", () => {
    const f = { ...emptyMessageForm("IN:REPLY"), channel: "LINKEDIN" as const, subject: "x", sentAtLocal: "2026-09-25T12:00" };
    const p = messageFormToPayload(f);
    expect(p).toMatchObject({ direction: "IN", type: "REPLY", channel: "LINKEDIN", subject: "", listingId: null });
    expect(messageFormToPayload({ ...f, sentAtLocal: "" })).toEqual({ error: "pick when it happened" });
  });
});
