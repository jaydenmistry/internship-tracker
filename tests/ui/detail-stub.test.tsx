// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DetailStub from "@/app/listings/DetailStub";
import { prepareRows, type TableRow } from "@/app/listings/table-state";
import type { ListingRow } from "@/lib/listings/query";

/**
 * The detail panel renders scraped company/role text and a scraped apply URL.
 * Text must reach the DOM as text, and an href that isn't plain http(s) must
 * not be rendered at all.
 */

const NASTY = '<img src=x onerror="window.__pwned=true"><b>bold</b>';

function row(overrides: Partial<ListingRow> = {}): TableRow {
  const base: ListingRow = {
    id: "l1",
    rank: 1,
    previousRank: null,
    company: "Acme",
    faangPlus: false,
    title: "Software Engineer Intern",
    location: "Atlanta, GA",
    locationCount: 1,
    allLocations: ["Atlanta, GA"],
    remote: false,
    url: "https://example.com/job",
    score: 72,
    llmAdjustment: null,
    postedAt: null,
    firstSeen: new Date(2026, 2, 1, 12).toISOString(),
    deadline: null,
    saved: false,
    dismissed: false,
    disqualified: false,
    disqualifyReason: null,
    likelyClosed: false,
    sources: ["simplify"],
    status: null,
    hasPostingText: true,
    fetchStatus: "ok",
    ...overrides,
  };
  return prepareRows([base])[0];
}

// Vitest runs without globals here, so RTL's automatic cleanup never registers.
afterEach(cleanup);

describe("DetailStub", () => {
  it("renders scraped company and role as literal text", () => {
    render(<DetailStub row={row({ company: NASTY, title: NASTY })} onClose={() => {}} />);

    const panel = screen.getByLabelText("Listing detail");
    expect(panel.textContent).toContain("<b>bold</b>");
    expect(panel.querySelector("img")).toBeNull();
    expect(panel.querySelector("b")).toBeNull();
    expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
  });

  it("renders an http(s) apply link with noopener noreferrer", () => {
    render(<DetailStub row={row({ url: "https://jobs.example.com/42" })} onClose={() => {}} />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://jobs.example.com/42");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  it("renders no link at all for a javascript: URL", () => {
    render(<DetailStub row={row({ url: "javascript:alert(1)" })} onClose={() => {}} />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/no usable apply link/i)).toBeTruthy();
  });

  it("carries the couldn't-fetch marker through to the panel", () => {
    render(<DetailStub row={row({ fetchStatus: "http_403" })} onClose={() => {}} />);

    const badge = screen.getByText(/no text · 403/);
    expect(badge.getAttribute("title")).toMatch(/403/);
  });

  it("says plainly that it is a stub", () => {
    render(<DetailStub row={row()} onClose={() => {}} />);

    expect(
      screen.getByText(
        "Full breakdown, resume match and timeline land in the next deliverable.",
      ),
    ).toBeTruthy();
  });

  it("shows the disqualify reason when the listing is disqualified", () => {
    render(
      <DetailStub
        row={row({ disqualified: true, disqualifyReason: "not an internship" })}
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Disqualified: not an internship/)).toBeTruthy();
  });
});
