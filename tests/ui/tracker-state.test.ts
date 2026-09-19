import { describe, expect, it } from "vitest";
import type { TrackerApplication } from "@/lib/applications/tracker";
import {
  applyStatusPatch,
  COLUMNS,
  effectiveNotes,
  formatResponseRate,
  groupIntoColumns,
  persistedNotes,
  relativeAge,
  safeHttpUrl,
} from "@/app/tracker/state";

function trackerApp(overrides: Partial<TrackerApplication> = {}): TrackerApplication {
  return {
    id: "a1",
    listingId: "l1",
    company: "Acme",
    role: "Software Engineer Intern",
    location: "Atlanta, GA",
    status: "APPLIED",
    appliedAt: "2026-09-10T12:00:00.000Z",
    updatedAt: "2026-09-10T12:00:00.000Z",
    lastEventAt: "2026-09-10T12:00:00.000Z",
    notes: null,
    url: "https://example.com/job",
    requisitionId: null,
    score: 72,
    rank: 5,
    likelyClosed: false,
    ...overrides,
  };
}

describe("groupIntoColumns", () => {
  it("returns every tracker status in pipeline order, even with no applications", () => {
    const cols = groupIntoColumns([]);
    expect(cols.map((c) => c.status)).toEqual([
      "APPLIED",
      "OA",
      "PHONE_SCREEN",
      "INTERVIEW",
      "OFFER",
      "REJECTED",
      "CLOSED",
      "SKIPPED",
    ]);
    expect(cols.every((c) => c.apps.length === 0)).toBe(true);
  });

  it("puts each application in its status column, preserving input order, manual apps included", () => {
    const apps = [
      trackerApp({ id: "1", status: "OA" }),
      trackerApp({ id: "2", status: "APPLIED", listingId: null, score: null, rank: null }),
      trackerApp({ id: "3", status: "OA" }),
      trackerApp({ id: "4", status: "SKIPPED", listingId: null }),
    ];
    const cols = groupIntoColumns(apps);
    const ids = Object.fromEntries(cols.map((c) => [c.status, c.apps.map((a) => a.id)]));
    expect(ids).toEqual({
      APPLIED: ["2"],
      OA: ["1", "3"],
      PHONE_SCREEN: [],
      INTERVIEW: [],
      OFFER: [],
      REJECTED: [],
      CLOSED: [],
      SKIPPED: ["4"],
    });
  });

  it("drops a NOT_APPLIED row rather than inventing a column for it", () => {
    const cols = groupIntoColumns([trackerApp({ status: "NOT_APPLIED" })]);
    expect(cols).toHaveLength(COLUMNS.length);
    expect(cols.flatMap((c) => c.apps)).toHaveLength(0);
  });
});

describe("formatResponseRate", () => {
  it("says so in words when nothing has been submitted", () => {
    expect(formatResponseRate(null)).toBe("no submitted applications yet");
    expect(formatResponseRate(Number.NaN)).toBe("no submitted applications yet");
  });

  it("rounds to a whole percentage", () => {
    expect(formatResponseRate(2 / 3)).toBe("67%");
    expect(formatResponseRate(0)).toBe("0%");
    expect(formatResponseRate(1)).toBe("100%");
  });
});

describe("applyStatusPatch (optimistic overlay)", () => {
  const at = "2026-09-19T15:00:00.000Z";

  it("moves the application and stamps the change without mutating the base", () => {
    const base = [trackerApp({ id: "1" }), trackerApp({ id: "2" })];
    const snapshot = structuredClone(base);
    const patched = applyStatusPatch(base, { id: "1", status: "OA", at });

    expect(patched[0]).toMatchObject({ status: "OA", lastEventAt: at, appliedAt: base[0].appliedAt });
    expect(patched[1]).toBe(base[1]);
    expect(groupIntoColumns(patched).find((c) => c.status === "OA")!.apps.map((a) => a.id)).toEqual(["1"]);
    // Revert = drop the overlay and show the base again, which is untouched.
    expect(base).toEqual(snapshot);
    expect(groupIntoColumns(base).find((c) => c.status === "OA")!.apps).toHaveLength(0);
  });

  it("stacks patches in order, like concurrent pending transitions", () => {
    const base = [trackerApp({ id: "1" })];
    const once = applyStatusPatch(base, { id: "1", status: "OA", at });
    const twice = applyStatusPatch(once, { id: "1", status: "REJECTED", at });
    expect(twice[0].status).toBe("REJECTED");
    expect(base[0].status).toBe("APPLIED");
  });

  it("removes the row for NOT_APPLIED, matching the server loader", () => {
    const base = [trackerApp({ id: "1" }), trackerApp({ id: "2" })];
    expect(applyStatusPatch(base, { id: "1", status: "NOT_APPLIED", at }).map((a) => a.id)).toEqual(["2"]);
    expect(base).toHaveLength(2);
  });

  it("is a no-op for an unknown id or an unchanged status", () => {
    const base = [trackerApp({ id: "1" })];
    expect(applyStatusPatch(base, { id: "zzz", status: "OA", at })).toEqual(base);
    expect(applyStatusPatch(base, { id: "1", status: "APPLIED", at })[0]).toBe(base[0]);
  });

  it("works for manual applications (no listing)", () => {
    const base = [trackerApp({ id: "m", listingId: null, score: null, rank: null })];
    expect(applyStatusPatch(base, { id: "m", status: "INTERVIEW", at })[0].status).toBe("INTERVIEW");
  });
});

describe("notes precedence", () => {
  const app = { id: "1", notes: "from server" };
  it("prefers an unsaved draft, then a value saved this session, then the server copy", () => {
    expect(effectiveNotes(app, {}, {})).toBe("from server");
    expect(effectiveNotes(app, {}, { "1": "saved" })).toBe("saved");
    expect(effectiveNotes(app, { "1": "draft" }, { "1": "saved" })).toBe("draft");
    // An empty draft is still a draft — clearing notes must not snap back.
    expect(effectiveNotes(app, { "1": "" }, {})).toBe("");
    expect(persistedNotes(app, {})).toBe("from server");
    expect(effectiveNotes({ id: "2", notes: null }, {}, {})).toBe("");
  });
});

describe("safeHttpUrl / relativeAge", () => {
  it("only allows http(s) hrefs", () => {
    expect(safeHttpUrl("https://x.com/a")).toBe("https://x.com/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl(" JAVASCRIPT:alert(1)")).toBeNull();
    expect(safeHttpUrl("data:text/html,<b>")).toBeNull();
    expect(safeHttpUrl(null)).toBeNull();
  });

  it("formats compact ages", () => {
    const now = Date.parse("2026-09-19T12:00:00Z");
    expect(relativeAge(null, now)).toBe("—");
    expect(relativeAge("2026-09-19T08:00:00Z", now)).toBe("today");
    expect(relativeAge("2026-09-16T12:00:00Z", now)).toBe("3d");
    expect(relativeAge("2026-08-29T12:00:00Z", now)).toBe("3w");
    expect(relativeAge("2026-05-19T12:00:00Z", now)).toBe("4mo");
  });
});
