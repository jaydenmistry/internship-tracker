import type { AppStatus } from "@/generated/prisma/enums";
import { safeHttpUrl, type PatchMap, type RowPatch, type TableRow } from "./table-state";

/**
 * The single action registry for a listing row.
 *
 * Keyboard shortcuts, the right-click menu and the detail panel's controls all
 * dispatch a `RowCommand` through `runRowCommand` (wrapped by `useRowActions`).
 * The optimistic patch, the server call and the revert-on-failure exist once,
 * here — no entry point carries its own copy of the mutation logic.
 *
 * Everything in this module is plain data + injected effects, so the rules
 * (what a toggle flips to, what a failure restores) are unit-testable without
 * React or a server.
 */

/** Notes cap, shared by the textarea and the Server Action's schema: generous,
 *  but a public endpoint must not accept unbounded text. */
export const NOTES_MAX = 20_000;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type MutationCommand =
  | { kind: "setStatus"; status: AppStatus }
  | { kind: "toggleApplied" }
  | { kind: "toggleSaved" }
  | { kind: "toggleDismissed" };

export type RowCommand =
  | MutationCommand
  | { kind: "openUrl" }
  | { kind: "copyUrl" }
  | { kind: "copyLabel" }
  | { kind: "openDetail" };

/** The fields a command reads. A TableRow satisfies it. */
export type ActionRow = Pick<
  TableRow,
  "id" | "statusKey" | "saved" | "dismissed" | "url" | "company" | "title"
>;

/** What gets sent to the server for a mutation, after toggles are resolved. */
export type ServerRequest =
  | { kind: "status"; status: AppStatus }
  | { kind: "saved"; value: boolean }
  | { kind: "dismissed"; value: boolean };

export interface PlannedMutation {
  patch: RowPatch;
  request: ServerRequest;
}

export function isMutation(command: RowCommand): command is MutationCommand {
  return (
    command.kind === "setStatus" ||
    command.kind === "toggleApplied" ||
    command.kind === "toggleSaved" ||
    command.kind === "toggleDismissed"
  );
}

/**
 * Resolves a mutation against the row's CURRENT (already patched) state: a
 * toggle means "the opposite of what is on screen", never of what the server
 * last said. "Not applied" is stored as `status: null` in the overlay — the
 * same shape the table uses for "no Application row".
 */
export function planMutation(row: ActionRow, command: MutationCommand): PlannedMutation {
  switch (command.kind) {
    case "setStatus":
      return statusPlan(command.status);
    case "toggleApplied":
      return statusPlan(row.statusKey === "APPLIED" ? "NOT_APPLIED" : "APPLIED");
    case "toggleSaved":
      return { patch: { saved: !row.saved }, request: { kind: "saved", value: !row.saved } };
    case "toggleDismissed":
      return {
        patch: { dismissed: !row.dismissed },
        request: { kind: "dismissed", value: !row.dismissed },
      };
  }
}

function statusPlan(status: AppStatus): PlannedMutation {
  return {
    patch: { status: status === "NOT_APPLIED" ? null : status },
    request: { kind: "status", status },
  };
}

// ---------------------------------------------------------------------------
// Optimistic overlay
// ---------------------------------------------------------------------------

/** Layers `patch` over a row's overlay; `previous` holds what it replaced
 *  (`undefined` = "had no override", which is what a revert restores to). */
export function applyOptimistic(
  patches: PatchMap,
  id: string,
  patch: RowPatch,
): { next: PatchMap; previous: RowPatch } {
  const before = patches[id] ?? {};
  const previous: RowPatch = {};
  for (const key of Object.keys(patch) as Array<keyof RowPatch>) {
    (previous as Record<string, unknown>)[key] = before[key];
  }
  return { next: { ...patches, [id]: { ...before, ...patch } }, previous };
}

/**
 * Undoes one failed mutation. A key is restored only if it still holds the
 * value this mutation wrote: if a later keystroke already changed it, that
 * newer intent wins and is left alone.
 */
export function revertOptimistic(
  patches: PatchMap,
  id: string,
  patch: RowPatch,
  previous: RowPatch,
): PatchMap {
  const current = patches[id];
  if (!current) return patches;
  const reverted: RowPatch = { ...current };
  for (const key of Object.keys(patch) as Array<keyof RowPatch>) {
    if (current[key] !== patch[key]) continue;
    if (previous[key] === undefined) delete reverted[key];
    else (reverted as Record<string, unknown>)[key] = previous[key];
  }
  const next = { ...patches };
  if (Object.keys(reverted).length === 0) delete next[id];
  else next[id] = reverted;
  return next;
}

// ---------------------------------------------------------------------------
// Running a command
// ---------------------------------------------------------------------------

export type SendResult = { ok: true } | { ok: false; message: string };

export interface RowActionDeps {
  getPatches: () => PatchMap;
  setPatches: (next: PatchMap) => void;
  send: (listingId: string, request: ServerRequest) => Promise<SendResult>;
  notify: (toast: Toast) => void;
  /** Called once a mutation has been confirmed by the server. */
  onSettled?: (listingId: string) => void;
  openDetail: (listingId: string) => void;
  openWindow: (href: string) => void;
  writeClipboard: (text: string) => Promise<void>;
}

export interface Toast {
  kind: "ok" | "error";
  message: string;
}

/** "Company — Role", the plain-text form the menu copies. */
export function rowLabel(row: Pick<ActionRow, "company" | "title">): string {
  return `${row.company} — ${row.title}`;
}

/**
 * Dispatches one command. Resolves to true when it succeeded (for a mutation:
 * the server accepted it), false when it failed and was reported — it never
 * throws, because a thrown error in a key handler would just vanish.
 */
export async function runRowCommand(
  row: ActionRow,
  command: RowCommand,
  deps: RowActionDeps,
): Promise<boolean> {
  if (isMutation(command)) return runMutation(row, command, deps);

  switch (command.kind) {
    case "openDetail":
      deps.openDetail(row.id);
      return true;
    case "openUrl": {
      // Scraped URLs: anything that isn't plain http(s) never reaches window.open.
      const href = safeHttpUrl(row.url);
      if (!href) {
        deps.notify({ kind: "error", message: "This listing has no usable apply link." });
        return false;
      }
      deps.openWindow(href);
      return true;
    }
    case "copyUrl": {
      const href = safeHttpUrl(row.url);
      if (!href) {
        deps.notify({ kind: "error", message: "This listing has no usable apply link." });
        return false;
      }
      return copy(href, "Apply link copied", deps);
    }
    case "copyLabel":
      return copy(rowLabel(row), "Copied “Company — Role”", deps);
  }
}

async function copy(text: string, done: string, deps: RowActionDeps): Promise<boolean> {
  try {
    await deps.writeClipboard(text);
    deps.notify({ kind: "ok", message: done });
    return true;
  } catch (err) {
    deps.notify({
      kind: "error",
      message: `Couldn't copy to the clipboard${
        err instanceof Error && err.message ? `: ${err.message.replace(/[.\s]+$/, "")}` : ""
      }. The page may not be in a secure context, or clipboard access was denied.`,
    });
    return false;
  }
}

async function runMutation(
  row: ActionRow,
  command: MutationCommand,
  deps: RowActionDeps,
): Promise<boolean> {
  const { patch, request } = planMutation(row, command);
  const { next, previous } = applyOptimistic(deps.getPatches(), row.id, patch);
  deps.setPatches(next);

  let result: SendResult;
  try {
    result = await deps.send(row.id, request);
  } catch (err) {
    result = { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  if (result.ok) {
    deps.onSettled?.(row.id);
    return true;
  }
  deps.setPatches(revertOptimistic(deps.getPatches(), row.id, patch, previous));
  deps.notify({ kind: "error", message: result.message });
  return false;
}

/** Wraps `navigator.clipboard.writeText`, which is absent outside a secure
 *  context — reject rather than silently do nothing. */
export async function writeClipboard(
  text: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined = typeof navigator !== "undefined"
    ? navigator.clipboard
    : undefined,
): Promise<void> {
  if (!clipboard || typeof clipboard.writeText !== "function") {
    throw new Error("clipboard unavailable");
  }
  await clipboard.writeText(text);
}
