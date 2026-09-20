// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import DetailPanel, { type DetailLoadState } from "@/app/listings/DetailPanel";
import type { ListingDetail } from "@/lib/listings/detail";
import type { RowCommand, SendResult } from "@/app/listings/row-actions";
import { detailFixture, rowFixture } from "./fixtures/listing-detail";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const NOW = new Date("2026-09-19T12:00:00.000Z").getTime();

function renderPanel(
  detail: Partial<ListingDetail> = {},
  opts: {
    row?: Parameters<typeof rowFixture>[0];
    onCommand?: (command: RowCommand) => void;
    onSaveNotes?: (id: string, notes: string) => Promise<SendResult>;
    load?: DetailLoadState;
  } = {},
) {
  const d = detailFixture(detail);
  const onCommand = opts.onCommand ?? vi.fn<(command: RowCommand) => void>();
  const onSaveNotes = opts.onSaveNotes ?? vi.fn(async () => ({ ok: true }) as SendResult);
  render(
    <DetailPanel
      row={rowFixture({ id: d.id, ...opts.row })}
      load={opts.load ?? { status: "ready", detail: d, refreshing: false }}
      now={NOW}
      onCommand={onCommand}
      onSaveNotes={onSaveNotes}
      onRetry={() => {}}
      onClose={() => {}}
    />,
  );
  return { panel: screen.getByLabelText("Listing detail"), onCommand, onSaveNotes };
}

describe("Claude assessment", () => {
  it("says plainly that none has run when llm is null (with text)", () => {
    renderPanel({ llm: null, hasPostingText: true });
    const none = screen.getByTestId("llm-none");
    expect(none.textContent).toMatch(/No Claude assessment has run for this posting.s current text/);
    expect(none.textContent).toMatch(/rule-based score alone/);
    expect(screen.queryByTestId("llm-rationale")).toBeNull();
  });

  it("explains that stage 2 skips postings with no text", () => {
    renderPanel({ llm: null, hasPostingText: false });
    expect(screen.getByTestId("llm-none").textContent).toMatch(/no posting text/);
  });

  it("shows the adjustment, model and rationale when present", () => {
    renderPanel({
      llmAdjustment: -4,
      llm: { adjustment: -4, rationale: "Mostly QA work.", model: "claude-x", createdAt: "2026-09-18T10:00:00.000Z" },
    });
    expect(screen.getByTestId("llm-rationale").textContent).toBe("Mostly QA work.");
    expect(screen.getByLabelText("Claude assessment").textContent).toMatch(/-4 · claude-x/);
  });
});

/**
 * The merge audit is the only place a wrong merge can be seen and undone, so
 * it has to name what would be split apart and dispatch through the same
 * command registry as every other row action.
 */
describe("merged-in sources", () => {
  const merge = {
    source: "intern-list",
    sourceUid: "6aad91e7de327d3e210d33d9",
    url: "https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9",
    reason: "single exact dedupKey match, identities inconclusive",
    mergedAt: "2026-09-08T06:00:00.000Z",
  };

  it("is absent when nothing was merged in", () => {
    renderPanel({ merges: [], splitFrom: [], unreadableMerges: 0 });
    expect(screen.queryByTestId("merged-sources")).toBeNull();
  });

  it("names each merged-in record, why it merged and when", () => {
    renderPanel({ merges: [merge] });
    const entry = screen.getByTestId("merged-source");
    expect(entry.textContent).toContain("intern-list");
    expect(entry.textContent).toContain("6aad91e7de327d3e210d33d9");
    expect(entry.textContent).toContain("single exact dedupKey match");
    expect(entry.textContent).toMatch(/merged .*8 Sep 2026/);
    expect(within(entry).getByRole("link")).toHaveProperty(
      "href",
      "https://jobright.ai/jobs/info/6aad91e7de327d3e210d33d9",
    );
  });

  it("dispatches the split through the row command registry", () => {
    const { onCommand } = renderPanel({ merges: [merge] });
    fireEvent.click(within(screen.getByTestId("merged-source")).getByRole("button"));
    expect(onCommand).toHaveBeenCalledWith({
      kind: "splitMerge",
      source: "intern-list",
      sourceUid: "6aad91e7de327d3e210d33d9",
    });
  });

  it("never links a merged record's non-http url", () => {
    renderPanel({ merges: [{ ...merge, url: "javascript:alert(1)" }] });
    const entry = screen.getByTestId("merged-source");
    expect(within(entry).queryByRole("link")).toBeNull();
    expect(entry.textContent).toContain("no usable link");
  });

  it("shows that this listing is itself the result of a split", () => {
    renderPanel({
      merges: [],
      splitFrom: [
        {
          fromListingId: "l9",
          source: "intern-list",
          sourceUid: "u9",
          reason: "fuzzy candidate 0.91",
          splitAt: "2026-09-19T09:30:00.000Z",
        },
      ],
    });
    expect(screen.getByTestId("split-origin").textContent).toMatch(/Split out of another listing/);
  });

  it("does not hide merge entries it could not read", () => {
    renderPanel({ merges: [], unreadableMerges: 2 });
    expect(screen.getByTestId("merged-sources").textContent).toMatch(
      /2 merge entries could not be read/,
    );
  });
});

describe("resume keyword match", () => {
  it("no-posting-text: says there is nothing to compare", () => {
    renderPanel({ resumeMatch: { state: "no-posting-text" } });
    const node = screen.getByTestId("resume-match");
    expect(node.dataset.state).toBe("no-posting-text");
    expect(node.textContent).toMatch(/No posting text/);
    expect(node.querySelectorAll("[data-keyword]")).toHaveLength(0);
  });

  it("no-resume: lists the posting's keywords and links to the upload page", () => {
    renderPanel({ resumeMatch: { state: "no-resume", postingKeywords: ["Go", "Kubernetes"] } });
    const node = screen.getByTestId("resume-match");
    expect(node.textContent).toMatch(/No resume uploaded yet/);
    // The empty state has to say how to leave it, not just that it is empty.
    expect(node.querySelector('a[href="/resume"]')).not.toBeNull();
    const kws = [...node.querySelectorAll("[data-keyword]")].map((n) => n.textContent);
    expect(kws).toEqual(["Go", "Kubernetes"]);
  });

  it("matched: hits and misses are visually distinct", () => {
    renderPanel({
      resumeMatch: {
        state: "matched",
        hits: ["TypeScript", "React"],
        misses: ["Go"],
        resumeUploadedAt: "2026-09-01T00:00:00.000Z",
      },
    });
    const node = screen.getByTestId("resume-match");
    expect(node.textContent).toMatch(/2 of 3 posting keywords/);
    const hits = node.querySelectorAll('[data-keyword="hit"]');
    const misses = node.querySelectorAll('[data-keyword="miss"]');
    expect([...hits].map((n) => n.textContent)).toEqual(["✓ TypeScript", "✓ React"]);
    expect([...misses].map((n) => n.textContent)).toEqual(["✗ Go"]);
    expect(hits[0].className).not.toBe(misses[0].className);
  });
});

describe("posting fetch", () => {
  it("shows the label and the plain-language detail for a failed fetch", () => {
    const detail = "The posting page couldn't be fetched (Blocked (HTTP 403)). Its score was computed without posting text.";
    renderPanel({
      hasPostingText: false,
      fetch: { status: "http_403", label: "Blocked (HTTP 403)", detail, failed: true },
    });
    const node = screen.getByTestId("fetch-status");
    expect(node.textContent).toContain("Blocked (HTTP 403)");
    expect(node.textContent).toContain(detail);
    expect(node.className).toMatch(/border-warn/);
  });

  it("is quiet for a successful fetch", () => {
    renderPanel();
    expect(screen.getByTestId("fetch-status").className).not.toMatch(/border-warn/);
  });
});

describe("score breakdown and disqualification", () => {
  it("shows each component's points/max, weight, contribution and evidence", () => {
    renderPanel();
    const list = screen.getByTestId("breakdown");
    const items = list.querySelectorAll(":scope > li");
    expect(items).toHaveLength(6);
    const tech = items[0];
    expect(tech.textContent).toContain("Tech fit");
    expect(tech.textContent).toContain("18/30");
    expect(tech.textContent).toContain("35");
    expect(tech.textContent).toContain("+21.3");
    expect(tech.textContent).toContain("TypeScript");
  });

  it("lists every disqualify reason and the would-be score", () => {
    renderPanel(
      {
        disqualified: true,
        score: 0,
        undisqualifiedScore: 64,
        disqualifyReasons: ["requires PhD", "Canada/UK/EU work authorization"],
      },
      { row: { disqualified: true, rank: null, disqualifyReasons: ["requires PhD", "Canada/UK/EU work authorization"] } },
    );
    const reasons = [...screen.getByTestId("dq-reasons").querySelectorAll("li")].map((l) => l.textContent);
    expect(reasons).toEqual(["requires PhD", "Canada/UK/EU work authorization"]);
    expect(screen.getByText(/on 2 grounds/)).toBeTruthy();
    expect(screen.getByText(/Would score 64/)).toBeTruthy();
  });
});

describe("status controls and timeline", () => {
  it("dispatches through the shared command handler", () => {
    const { onCommand } = renderPanel();
    fireEvent.click(within(screen.getByRole("group", { name: "Status controls" })).getByText("interview"));
    expect(onCommand).toHaveBeenCalledWith({ kind: "setStatus", status: "INTERVIEW" });
    fireEvent.click(screen.getByRole("button", { name: /^Save/ }));
    expect(onCommand).toHaveBeenCalledWith({ kind: "toggleSaved" });
  });

  it("marks the row's current status as pressed", () => {
    renderPanel({}, { row: { status: "OA" } });
    expect(screen.getByRole("button", { name: "OA" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("renders the timeline chronologically, from → to", () => {
    renderPanel({
      application: {
        id: "a1",
        status: "OA",
        appliedAt: "2026-09-10T00:00:00.000Z",
        notes: null,
        requisitionId: null,
        applyUrl: null,
        timeline: [
          { fromStatus: null, toStatus: "APPLIED", occurredAt: "2026-09-10T14:00:00.000Z", note: null },
          { fromStatus: "APPLIED", toStatus: "OA", occurredAt: "2026-09-12T14:00:00.000Z", note: "HackerRank" },
        ],
      },
    });
    const items = screen.getByTestId("timeline").querySelectorAll("li");
    expect(items[0].textContent).toMatch(/—→applied/);
    expect(items[1].textContent).toMatch(/applied→OA/);
    expect(items[1].textContent).toContain("HackerRank");
  });
});

describe("notes", () => {
  it("saves on blur and shows the saved state", async () => {
    const onSaveNotes = vi.fn(async () => ({ ok: true }) as SendResult);
    renderPanel({}, { onSaveNotes });
    const box = screen.getByLabelText("Listing notes");
    fireEvent.change(box, { target: { value: "ask about team" } });
    await act(async () => {
      fireEvent.blur(box);
    });
    expect(onSaveNotes).toHaveBeenCalledWith("l1", "ask about team");
    expect(screen.getByLabelText("Listing notes").closest("section")?.textContent).toMatch(/saved/);
  });

  it("saves after typing pauses (debounced)", async () => {
    vi.useFakeTimers();
    const onSaveNotes = vi.fn(async () => ({ ok: true }) as SendResult);
    renderPanel({}, { onSaveNotes });
    fireEvent.change(screen.getByLabelText("Listing notes"), { target: { value: "a" } });
    fireEvent.change(screen.getByLabelText("Listing notes"), { target: { value: "ab" } });
    expect(onSaveNotes).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1100);
    });
    expect(onSaveNotes).toHaveBeenCalledTimes(1);
    expect(onSaveNotes).toHaveBeenCalledWith("l1", "ab");
  });

  it("keeps the text and offers a retry when the save fails", async () => {
    const onSaveNotes = vi.fn(async () => ({ ok: false, message: "db down" }) as SendResult);
    renderPanel({ id: "notes-fail" }, { onSaveNotes });
    const box = screen.getByLabelText("Listing notes") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "do not lose me" } });
    await act(async () => {
      fireEvent.blur(box);
    });
    expect(box.value).toBe("do not lose me");
    expect(screen.getByRole("alert").textContent).toMatch(/Couldn.t save.*db down/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });

  it("restores an unsaved draft when the listing is reopened", async () => {
    const onSaveNotes = vi.fn(async () => ({ ok: false, message: "offline" }) as SendResult);
    renderPanel({ id: "notes-reopen" }, { onSaveNotes });
    fireEvent.change(screen.getByLabelText("Listing notes"), { target: { value: "draft text" } });
    await act(async () => {
      fireEvent.blur(screen.getByLabelText("Listing notes"));
    });
    cleanup();
    renderPanel({ id: "notes-reopen", application: null });
    expect((screen.getByLabelText("Listing notes") as HTMLTextAreaElement).value).toBe("draft text");
  });
});

describe("load states", () => {
  it("shows loading, then an error with a retry", () => {
    renderPanel({}, { load: { status: "loading" } });
    expect(screen.getByText(/Loading details/)).toBeTruthy();
    cleanup();
    renderPanel({}, { load: { status: "error", message: "boom" } });
    expect(screen.getByRole("alert").textContent).toMatch(/boom/);
  });
});
