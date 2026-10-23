// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The actions module imports Prisma; the hook only needs callable stubs.
vi.mock("@/app/listings/actions", () => ({
  setStatusAction: vi.fn(async ({ status }: { status: string }) => ({
    ok: true,
    status: status === "NOT_APPLIED" ? null : status,
    progress: status === "APPLIED" ? { total: 5, today: 3, streak: 2, milestone: 5 } : undefined,
  })),
  setSavedAction: vi.fn(async () => ({ ok: true })),
  setDismissedAction: vi.fn(async () => ({ ok: true })),
  setNotesAction: vi.fn(async () => ({ ok: true })),
  splitMergeAction: vi.fn(async () => ({ ok: true })),
}));

import { setStatusAction } from "@/app/listings/actions";
import type { Toast } from "@/app/listings/row-actions";
import { useRowActions } from "@/app/listings/useRowActions";
import { rowFixture } from "./fixtures/listing-detail";

function setup() {
  const notify = vi.fn<(t: Toast) => void>();
  const hook = renderHook(() =>
    useRowActions({ notify, openDetail: vi.fn(), onSettled: vi.fn(), onSplit: vi.fn() }),
  );
  return { notify, hook };
}

describe("celebrating from the listings table", () => {
  it("applies with a celebration toast that carries the milestone, streak and an Undo", async () => {
    const { notify, hook } = setup();
    const row = rowFixture({ company: "Ramp" });
    await act(async () => {
      await hook.result.current.perform(row, { kind: "toggleApplied" });
    });
    const toast = notify.mock.calls.at(-1)?.[0];
    expect(toast?.kind).toBe("celebrate");
    expect(toast?.message).toMatch(/5 applications sent/);
    expect(toast?.message).toMatch(/2-day streak/);
    expect(toast?.action?.label).toBe("Undo");

    notify.mockClear();
    await act(async () => {
      toast?.action?.run();
    });
    expect(setStatusAction).toHaveBeenLastCalledWith({ listingId: row.id, status: "NOT_APPLIED" });
    // An undo is quiet.
    expect(notify).not.toHaveBeenCalled();
  });

  it("doesn't throw a party for un-applying or saving", async () => {
    const { notify, hook } = setup();
    await act(async () => {
      await hook.result.current.perform(rowFixture({ status: "APPLIED" }), { kind: "toggleApplied" });
      await hook.result.current.perform(rowFixture(), { kind: "toggleSaved" });
    });
    expect(notify.mock.calls.some(([t]) => t.kind === "celebrate")).toBe(false);
  });
});
