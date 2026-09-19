// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardStats, TrackerApplication } from "@/lib/applications/tracker";

// The actions module imports Prisma; the views only need callable stubs.
vi.mock("@/app/tracker/actions", () => ({
  setTrackerStatusAction: vi.fn(async () => ({ ok: true })),
  setTrackerNotesAction: vi.fn(async () => ({ ok: true })),
}));

import { setTrackerNotesAction, setTrackerStatusAction } from "@/app/tracker/actions";
import Dashboard from "@/app/tracker/Dashboard";
import TrackerView from "@/app/tracker/TrackerView";

afterEach(cleanup);

const NOW = "2026-09-19T12:00:00.000Z";
const NASTY = '<img src=x onerror="window.__pwned=true"><b>bold</b><script>window.__pwned=true</script>';

function app(overrides: Partial<TrackerApplication> = {}): TrackerApplication {
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

const EMPTY_STATS: DashboardStats = {
  byStage: {
    APPLIED: 0,
    OA: 0,
    PHONE_SCREEN: 0,
    INTERVIEW: 0,
    OFFER: 0,
    REJECTED: 0,
    CLOSED: 0,
    SKIPPED: 0,
  },
  total: 0,
  submitted: 0,
  responded: 0,
  responseRate: null,
  definition: "Response rate = responded / submitted.",
};

describe("empty state", () => {
  it("dashboard shows every stage at zero and words instead of a rate", () => {
    render(<Dashboard stats={EMPTY_STATS} />);
    const stages = screen.getByLabelText("Applications by stage");
    expect(within(stages).getAllByText("0")).toHaveLength(8);
    expect(screen.getByTestId("response-rate").textContent).toBe("no submitted applications yet");
    expect(document.body.textContent).not.toMatch(/NaN|0%/);
    expect(screen.getByText("Response rate = responded / submitted.")).toBeTruthy();
  });

  it("kanban renders all eight empty columns plus a hint to /import and the `a` shortcut", () => {
    render(<TrackerView apps={[]} view="kanban" nowIso={NOW} />);
    const board = screen.getByTestId("kanban");
    expect(board.querySelectorAll("section")).toHaveLength(8);
    expect(screen.queryAllByTestId("tracker-card")).toHaveLength(0);
    const hint = screen.getByTestId("empty-hint");
    expect(within(hint).getByRole("link", { name: "Import" }).getAttribute("href")).toBe("/import");
    expect(hint.querySelector("kbd")?.textContent).toBe("a");
    // CSV round-trip links are present even when empty.
    expect(screen.getByRole("link", { name: "Export CSV" }).getAttribute("href")).toBe(
      "/api/applications/export",
    );
    expect(screen.getByRole("link", { name: "Import CSV" }).getAttribute("href")).toBe("/import");
  });

  it("list view shows the hint in place of rows", () => {
    render(<TrackerView apps={[]} view="list" nowIso={NOW} />);
    expect(screen.queryAllByTestId("tracker-row")).toHaveLength(0);
    expect(screen.getByTestId("tracker-list").textContent).toContain("No applications yet");
  });
});

describe("manual applications", () => {
  it("renders a manual card with a manual marker, no score, and a working status select", () => {
    render(
      <TrackerView
        apps={[app({ id: "m1", listingId: null, score: null, rank: null, company: "Side Co", status: "OA" })]}
        view="kanban"
        nowIso={NOW}
      />,
    );
    const card = screen.getByTestId("tracker-card");
    expect(within(card).getByText("manual")).toBeTruthy();
    expect(within(card).getByText("Side Co")).toBeTruthy();
    expect(within(card).queryByText("72")).toBeNull();
    const select = within(card).getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("OA");
    // It sits in the OA column.
    const oa = screen.getByRole("region", { name: "OA: 1" });
    expect(within(oa).getByTestId("tracker-card")).toBe(card);
  });

  it("marks likely-closed listings", () => {
    render(<TrackerView apps={[app({ likelyClosed: true })]} view="list" nowIso={NOW} />);
    expect(within(screen.getByTestId("tracker-row")).getByText("closed?")).toBeTruthy();
  });
});

describe("untrusted text", () => {
  const hostile = app({
    company: NASTY,
    role: NASTY,
    notes: NASTY,
    location: NASTY,
    url: "javascript:window.__pwned=true",
  });

  for (const view of ["kanban", "list"] as const) {
    it(`${view}: renders markup in company/role/notes as literal text and drops a non-http href`, () => {
      render(<TrackerView apps={[hostile]} view={view} nowIso={NOW} />);
      const root = screen.getByTestId(view === "kanban" ? "tracker-card" : "tracker-row");
      expect(root.textContent).toContain("<b>bold</b>");
      expect(root.textContent).toContain("<script>");
      expect(root.querySelector("img, b, script")).toBeNull();
      for (const a of Array.from(document.querySelectorAll("a"))) {
        expect(a.getAttribute("href") ?? "").not.toMatch(/^javascript:/i);
      }
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
    });
  }

  it("opens a safe apply URL in a new tab without an opener", () => {
    render(<TrackerView apps={[app()]} view="list" nowIso={NOW} />);
    const link = screen.getByRole("link", { name: "open ↗" });
    expect(link.getAttribute("href")).toBe("https://example.com/job");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  });
});

describe("failure handling", () => {
  it("keeps typed notes when the save fails, and shows why", async () => {
    vi.mocked(setTrackerNotesAction).mockResolvedValueOnce({ ok: false, message: "saving notes failed: db down" });
    render(<TrackerView apps={[app({ notes: "old" })]} view="kanban" nowIso={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: /Notes for Acme/ }));
    const box = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "recruiter: Dana, follow up Fri" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "save" }));
    });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("db down"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("recruiter: Dana, follow up Fri");
    expect(setTrackerNotesAction).toHaveBeenCalledWith({ applicationId: "a1", notes: "recruiter: Dana, follow up Fri" });
  });

  it("reverts an optimistic status change the server rejected", async () => {
    let resolve!: (v: { ok: false; message: string }) => void;
    vi.mocked(setTrackerStatusAction).mockImplementationOnce(
      () => new Promise((r) => (resolve = r)),
    );
    render(<TrackerView apps={[app()]} view="kanban" nowIso={NOW} />);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "OA" } });
    // Optimistic: already in the OA column while the action is pending.
    await waitFor(() => expect(within(screen.getByRole("region", { name: "OA: 1" })).getByTestId("tracker-card")).toBeTruthy());
    await act(async () => resolve({ ok: false, message: "status change failed: nope" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "applied: 1" })).toBeTruthy());
    expect(screen.getByRole("region", { name: "OA: 0" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Reverted");
  });
});
