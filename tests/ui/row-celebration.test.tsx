// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// The actions module imports Prisma; the hook only needs callable stubs.
vi.mock("@/app/listings/actions", () => ({
  setStatusAction: vi.fn(async ({ status }: { status: string }) => ({
    ok: true,
    status: status === "NOT_APPLIED" ? null : status,
    progress:
      status === "APPLIED"
        ? { total: 5, today: 3, streak: 2, milestone: 5, week: 3, goal: 10, goalReached: false }
        : undefined,
    week: { week: 3, goal: 10 },
    unlocked:
      status === "APPLIED"
        ? [{ id: "night-owl", emoji: "🦉", title: "Night owl" }]
        : status === "SKIPPED"
          ? [{ id: "ten", emoji: "🔟", title: "Double digits" }]
          : undefined,
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

function setup(extra: Partial<Parameters<typeof useRowActions>[0]> = {}) {
  const notify = vi.fn<(t: Toast) => void>();
  const hook = renderHook(() =>
    useRowActions({ notify, openDetail: vi.fn(), onSettled: vi.fn(), onSplit: vi.fn(), ...extra }),
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
    expect(toast?.actions?.[0]?.label).toBe("Undo");

    notify.mockClear();
    await act(async () => {
      toast?.actions?.[0]?.run();
    });
    expect(setStatusAction).toHaveBeenLastCalledWith({ listingId: row.id, status: "NOT_APPLIED" });
    // An undo is quiet.
    expect(notify).not.toHaveBeenCalled();
  });

  it("names new badges and offers the next best role", async () => {
    const goTo = vi.fn();
    const nextBest = vi.fn(() => ({ id: "next-1", company: "Stripe", title: "SWE Intern", score: 91 }));
    const { notify, hook } = setup({ nextBest, goTo });
    const row = rowFixture({ company: "Ramp" });
    await act(async () => {
      await hook.result.current.perform(row, { kind: "toggleApplied" });
    });
    const toast = notify.mock.calls.at(-1)?.[0];
    expect(toast?.message).toMatch(/Unlocked: Night owl 🦉/);
    expect(nextBest).toHaveBeenCalledWith(row.id);
    const next = toast?.actions?.[1];
    expect(next?.label).toBe("Next: Stripe →");
    expect(next?.title).toMatch(/SWE Intern \(score 91\)/);
    next?.run();
    expect(goTo).toHaveBeenCalledWith("next-1");
  });

  it("tells the goal ring the week's count after any status change", async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("celebrate:week", listener);
    const { hook } = setup();
    await act(async () => {
      await hook.result.current.perform(rowFixture({ status: "APPLIED" }), { kind: "toggleApplied" });
    });
    window.removeEventListener("celebrate:week", listener);
    expect(seen).toEqual([{ week: 3, goal: 10 }]);
  });

  it("still shows a badge earned on a change that doesn't celebrate", async () => {
    const { notify, hook } = setup();
    await act(async () => {
      await hook.result.current.perform(rowFixture(), { kind: "setStatus", status: "SKIPPED" });
    });
    expect(notify.mock.calls.at(-1)?.[0]).toMatchObject({ kind: "celebrate", message: "🏅 Unlocked: Double digits 🔟" });
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
