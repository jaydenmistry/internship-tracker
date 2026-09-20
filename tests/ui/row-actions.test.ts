import { describe, expect, it, vi } from "vitest";
import {
  applyOptimistic,
  planMutation,
  revertOptimistic,
  rowLabel,
  runRowCommand,
  writeClipboard,
  type RowActionDeps,
  type SendResult,
  type SplitResult,
  type Toast,
} from "@/app/listings/row-actions";
import { applyPatches, type PatchMap } from "@/app/listings/table-state";
import { rowFixture } from "./fixtures/listing-detail";

/**
 * The one registry every entry point (keys, context menu, detail panel) goes
 * through: what each command patches optimistically, and that a refused
 * server call puts the row back exactly as it was.
 */

function harness(result: SendResult | Error = { ok: true }, initial: PatchMap = {}) {
  let patches = initial;
  const history: PatchMap[] = [];
  const toasts: Toast[] = [];
  const deps: RowActionDeps = {
    getPatches: () => patches,
    setPatches: (next) => {
      patches = next;
      history.push(next);
    },
    send: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    notify: (t) => toasts.push(t),
    onSettled: vi.fn(),
    openDetail: vi.fn(),
    splitMerge: vi.fn(async () => ({ ok: true, listingId: "l2", alreadySplit: false, label: "Acme — Intern" }) as SplitResult),
    onSplit: vi.fn(),
    openWindow: vi.fn(),
    writeClipboard: vi.fn(async () => {}),
  };
  return { deps, history, toasts, patches: () => patches };
}

describe("planMutation", () => {
  it("toggleApplied applies an untracked row and un-applies an applied one", () => {
    expect(planMutation(rowFixture(), { kind: "toggleApplied" })).toEqual({
      patch: { status: "APPLIED" },
      request: { kind: "status", status: "APPLIED" },
    });
    expect(planMutation(rowFixture({ status: "APPLIED" }), { kind: "toggleApplied" })).toEqual({
      patch: { status: null },
      request: { kind: "status", status: "NOT_APPLIED" },
    });
  });

  it("toggleApplied on a later-stage status sets APPLIED (not a no-op)", () => {
    expect(planMutation(rowFixture({ status: "INTERVIEW" }), { kind: "toggleApplied" }).patch).toEqual({
      status: "APPLIED",
    });
  });

  it("setStatus stores NOT_APPLIED as null, every other status as itself", () => {
    expect(planMutation(rowFixture(), { kind: "setStatus", status: "NOT_APPLIED" }).patch).toEqual({
      status: null,
    });
    expect(planMutation(rowFixture(), { kind: "setStatus", status: "OA" })).toEqual({
      patch: { status: "OA" },
      request: { kind: "status", status: "OA" },
    });
  });

  it("toggleSaved / toggleDismissed flip what is on screen", () => {
    expect(planMutation(rowFixture({ saved: false }), { kind: "toggleSaved" })).toEqual({
      patch: { saved: true },
      request: { kind: "saved", value: true },
    });
    expect(planMutation(rowFixture({ saved: true }), { kind: "toggleSaved" }).patch).toEqual({ saved: false });
    expect(planMutation(rowFixture({ dismissed: false }), { kind: "toggleDismissed" })).toEqual({
      patch: { dismissed: true },
      request: { kind: "dismissed", value: true },
    });
  });
});

describe("optimistic overlay", () => {
  it("records what it replaced and restores it verbatim", () => {
    const start: PatchMap = { l1: { saved: true } };
    const { next, previous } = applyOptimistic(start, "l1", { saved: false, status: "OA" });
    expect(next.l1).toEqual({ saved: false, status: "OA" });
    expect(previous).toEqual({ saved: true, status: undefined });
    expect(revertOptimistic(next, "l1", { saved: false, status: "OA" }, previous)).toEqual(start);
  });

  it("drops the row's entry when a revert leaves nothing overridden", () => {
    const { next, previous } = applyOptimistic({}, "l1", { dismissed: true });
    expect(revertOptimistic(next, "l1", { dismissed: true }, previous)).toEqual({});
  });

  it("does not clobber a newer change to the same field", () => {
    const first = applyOptimistic({}, "l1", { status: "APPLIED" });
    const second = applyOptimistic(first.next, "l1", { status: "OA" });
    // The FIRST call fails after the second was made: OA must survive.
    expect(revertOptimistic(second.next, "l1", { status: "APPLIED" }, first.previous).l1).toEqual({
      status: "OA",
    });
  });
});

describe("runRowCommand — mutations", () => {
  const cases = [
    { command: { kind: "toggleApplied" } as const, field: "status", optimistic: "APPLIED" },
    { command: { kind: "setStatus", status: "REJECTED" } as const, field: "status", optimistic: "REJECTED" },
    { command: { kind: "toggleSaved" } as const, field: "saved", optimistic: true },
    { command: { kind: "toggleDismissed" } as const, field: "dismissed", optimistic: true },
  ];

  for (const { command, field, optimistic } of cases) {
    it(`${command.kind}: patches first, keeps it on success`, async () => {
      const h = harness({ ok: true });
      const row = rowFixture();
      const ok = await runRowCommand(row, command, h.deps);

      expect(ok).toBe(true);
      expect(h.history[0].l1).toEqual({ [field]: optimistic });
      expect(h.patches().l1).toEqual({ [field]: optimistic });
      expect(h.deps.onSettled).toHaveBeenCalledWith("l1");
      expect(h.toasts).toEqual([]);
    });

    it(`${command.kind}: reverts and reports when the server refuses`, async () => {
      const h = harness({ ok: false, message: "db down" });
      const row = rowFixture();
      const ok = await runRowCommand(row, command, h.deps);

      expect(ok).toBe(false);
      expect(h.history[0].l1).toEqual({ [field]: optimistic }); // was shown…
      expect(h.patches()).toEqual({}); // …and taken back
      expect(applyPatches([row], h.patches())[0]).toEqual(row);
      expect(h.toasts).toEqual([{ kind: "error", message: "db down" }]);
      expect(h.deps.onSettled).not.toHaveBeenCalled();
    });
  }

  it("reverts when the call throws instead of returning ok:false", async () => {
    const h = harness(new Error("network"));
    const ok = await runRowCommand(rowFixture(), { kind: "toggleSaved" }, h.deps);
    expect(ok).toBe(false);
    expect(h.patches()).toEqual({});
    expect(h.toasts[0]).toEqual({ kind: "error", message: "network" });
  });

  it("restores an earlier pending override rather than the server value", async () => {
    const h = harness({ ok: false, message: "nope" }, { l1: { status: "APPLIED" } });
    const row = applyPatches([rowFixture()], { l1: { status: "APPLIED" } })[0];
    await runRowCommand(row, { kind: "setStatus", status: "OA" }, h.deps);
    expect(h.patches()).toEqual({ l1: { status: "APPLIED" } });
  });

  it("sends the resolved request", async () => {
    const h = harness();
    await runRowCommand(rowFixture({ status: "APPLIED" }), { kind: "toggleApplied" }, h.deps);
    expect(h.deps.send).toHaveBeenCalledWith("l1", { kind: "status", status: "NOT_APPLIED" });
  });
});

describe("runRowCommand — non-mutations", () => {
  it("opens only http(s) apply links", async () => {
    const h = harness();
    expect(await runRowCommand(rowFixture(), { kind: "openUrl" }, h.deps)).toBe(true);
    expect(h.deps.openWindow).toHaveBeenCalledWith("https://jobs.example.com/42");

    const bad = harness();
    expect(await runRowCommand(rowFixture({ url: "javascript:alert(1)" }), { kind: "openUrl" }, bad.deps)).toBe(false);
    expect(bad.deps.openWindow).not.toHaveBeenCalled();
    expect(bad.toasts[0].kind).toBe("error");
  });

  it("copies the apply link and confirms", async () => {
    const h = harness();
    await runRowCommand(rowFixture(), { kind: "copyUrl" }, h.deps);
    expect(h.deps.writeClipboard).toHaveBeenCalledWith("https://jobs.example.com/42");
    expect(h.toasts).toEqual([{ kind: "ok", message: "Apply link copied" }]);
  });

  it("copies “Company — Role” as plain text", async () => {
    const h = harness();
    await runRowCommand(rowFixture({ company: "<b>Acme</b>", title: "SWE Intern" }), { kind: "copyLabel" }, h.deps);
    expect(h.deps.writeClipboard).toHaveBeenCalledWith("<b>Acme</b> — SWE Intern");
    expect(rowLabel({ company: "A", title: "B" })).toBe("A — B");
  });

  it("reports a clipboard rejection instead of failing silently", async () => {
    const h = harness();
    h.deps.writeClipboard = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    expect(await runRowCommand(rowFixture(), { kind: "copyLabel" }, h.deps)).toBe(false);
    expect(h.toasts).toHaveLength(1);
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].message).toMatch(/clipboard/i);
  });

  it("openDetail hands the id over", async () => {
    const h = harness();
    await runRowCommand(rowFixture(), { kind: "openDetail" }, h.deps);
    expect(h.deps.openDetail).toHaveBeenCalledWith("l1", undefined);
    expect(h.deps.send).not.toHaveBeenCalled();
  });

  it("openDetail carries the section the caller wants shown", async () => {
    const h = harness();
    await runRowCommand(rowFixture(), { kind: "openDetail", focus: "merges" }, h.deps);
    expect(h.deps.openDetail).toHaveBeenCalledWith("l1", "merges");
  });
});

/**
 * A split creates a listing, so there is nothing to patch optimistically — the
 * table reloads instead. What matters is that the outcome is never silent: a
 * recovered listing is reported, and so is every refusal.
 */
describe("runRowCommand — splitMerge", () => {
  const command = { kind: "splitMerge", source: "intern-list", sourceUid: "u9" } as const;

  it("sends the entry and reports the recovered listing", async () => {
    const h = harness();
    expect(await runRowCommand(rowFixture(), command, h.deps)).toBe(true);
    expect(h.deps.splitMerge).toHaveBeenCalledWith("l1", "intern-list", "u9");
    expect(h.deps.onSplit).toHaveBeenCalledWith("l1", "l2");
    expect(h.toasts).toEqual([{ kind: "ok", message: "Split out Acme — Intern as its own listing." }]);
    // No optimistic patch: the row's own fields didn't change.
    expect(h.history).toHaveLength(0);
  });

  it("says so when the entry had already been split", async () => {
    const h = harness();
    h.deps.splitMerge = vi.fn(async () => ({
      ok: true as const,
      listingId: "l2",
      alreadySplit: true,
      label: "Acme — Intern",
    }));
    expect(await runRowCommand(rowFixture(), command, h.deps)).toBe(true);
    expect(h.toasts[0]).toEqual({
      kind: "ok",
      message: "Already split — Acme — Intern is its own listing.",
    });
  });

  it("surfaces a refusal from the server", async () => {
    const h = harness();
    h.deps.splitMerge = vi.fn(async () => ({
      ok: false as const,
      message: "This listing has no merged-in record from intern-list (u9).",
    }));
    expect(await runRowCommand(rowFixture(), command, h.deps)).toBe(false);
    expect(h.deps.onSplit).not.toHaveBeenCalled();
    expect(h.toasts[0].kind).toBe("error");
    expect(h.toasts[0].message).toContain("no merged-in record");
  });

  it("reports a thrown error instead of losing it", async () => {
    const h = harness();
    h.deps.splitMerge = vi.fn(async () => {
      throw new Error("network down");
    });
    expect(await runRowCommand(rowFixture(), command, h.deps)).toBe(false);
    expect(h.toasts[0]).toEqual({ kind: "error", message: "Couldn't split: network down" });
  });
});

describe("writeClipboard", () => {
  it("rejects when the Clipboard API is missing (non-secure context)", async () => {
    await expect(writeClipboard("x", undefined)).rejects.toThrow(/unavailable/);
  });

  it("delegates to writeText when present", async () => {
    const writeText = vi.fn(async () => {});
    await writeClipboard("hello", { writeText });
    expect(writeText).toHaveBeenCalledWith("hello");
  });
});
