// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import DetailPanel from "@/app/listings/DetailPanel";
import type { ListingDetail } from "@/lib/listings/detail";
import { detailFixture, rowFixture } from "./fixtures/listing-detail";

/**
 * Listing text is scraped from third-party job boards, evidence strings are
 * raw scraped substrings, the rationale is model output, and notes are user
 * text. All of it must reach the DOM as TEXT — never parsed as HTML or
 * markdown. These render the REAL detail panel, so they fail loudly if anyone
 * reaches for dangerouslySetInnerHTML or a markdown renderer there.
 */

const NASTY =
  '<script>window.__pwned = true</script><b>bold</b><img src=x onerror="window.__pwned=true">**md** [x](javascript:alert(1))';

afterEach(cleanup);

function renderNasty(overrides: Partial<ListingDetail> = {}) {
  const detail = detailFixture({
    company: NASTY,
    title: NASTY,
    locations: [NASTY],
    salary: NASTY,
    disqualified: true,
    disqualifyReasons: [NASTY],
    components: detailFixture().components.map((c) => ({ ...c, evidence: [`matched "Go" in ${NASTY}`] })),
    llmAdjustment: 3,
    llm: { adjustment: 3, rationale: `Strong fit. ${NASTY}`, model: NASTY, createdAt: "2026-09-18T00:00:00.000Z" },
    fetch: { status: "parse_failed", label: NASTY, detail: NASTY, failed: true },
    resumeMatch: { state: "matched", hits: [NASTY], misses: [`${NASTY}!`], resumeUploadedAt: "2026-09-01T00:00:00.000Z" },
    application: {
      id: "a1",
      status: "APPLIED",
      appliedAt: null,
      notes: `call back ${NASTY}`,
      requisitionId: NASTY,
      applyUrl: null,
      timeline: [{ fromStatus: null, toStatus: "APPLIED", occurredAt: "2026-09-10T00:00:00.000Z", note: NASTY }],
    },
    ...overrides,
  });
  render(
    <DetailPanel
      row={rowFixture({ company: NASTY, title: NASTY, disqualified: true, disqualifyReasons: [NASTY] })}
      load={{ status: "ready", detail, refreshing: false }}
      now={Date.parse("2026-09-19T00:00:00Z")}
      onCommand={() => {}}
      onSaveNotes={async () => ({ ok: true })}
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  return screen.getByLabelText("Listing detail");
}

function assertInert(node: HTMLElement) {
  expect(node.querySelector("script")).toBeNull();
  expect(node.querySelector("img")).toBeNull();
  expect(node.querySelector("b")).toBeNull();
  expect(node.querySelector("strong")).toBeNull();
  for (const a of node.querySelectorAll("a")) {
    expect(a.getAttribute("href")).toMatch(/^https?:\/\//);
  }
  expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined();
}

describe("detail panel renders untrusted text as text", () => {
  it("score-breakdown evidence", () => {
    renderNasty();
    const breakdown = screen.getByTestId("breakdown");
    expect(breakdown.textContent).toContain("<script>");
    expect(breakdown.textContent).toContain("<b>bold</b>");
    assertInert(breakdown);
  });

  it("the LLM rationale (no markdown either)", () => {
    renderNasty();
    const node = screen.getByTestId("llm-rationale");
    expect(node.textContent).toContain("<script>");
    expect(node.textContent).toContain("**md**");
    expect(node.textContent).toContain("[x](javascript:alert(1))");
    assertInert(node);
  });

  it("notes, in the textarea, exactly as typed", async () => {
    renderNasty();
    const box = screen.getByLabelText("Listing notes") as HTMLTextAreaElement;
    expect(box.value).toBe(`call back ${NASTY}`);
    await act(async () => {
      fireEvent.change(box, { target: { value: `${NASTY} edited` } });
      fireEvent.blur(box);
    });
    expect(box.value).toBe(`${NASTY} edited`);
    assertInert(box.closest("section") as HTMLElement);
  });

  it("company, role, reasons, fetch text, keywords and timeline notes", () => {
    const panel = renderNasty();
    expect(screen.getByTestId("dq-reasons").textContent).toContain("<img");
    expect(screen.getByTestId("fetch-status").textContent).toContain("<script>");
    expect(screen.getByTestId("resume-match").textContent).toContain("<b>bold</b>");
    expect(screen.getByTestId("timeline").textContent).toContain("<script>");
    expect(panel.querySelector("header")?.textContent).toContain("<b>bold</b>");
    assertInert(panel);
  });

  it("renders no link at all for a javascript: apply URL", () => {
    const panel = renderNasty({ url: "javascript:alert(1)" });
    expect(panel.querySelectorAll("a")).toHaveLength(0);
    expect(screen.getByText(/No usable apply link/)).toBeTruthy();
  });

  it("renders an http(s) apply link with noopener noreferrer", () => {
    renderNasty({ url: "https://jobs.example.com/42" });
    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://jobs.example.com/42");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });
});
