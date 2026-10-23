"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import { attrSelector, celebrate, celebrateDismiss, celebrateProgress, celebrateSave, celebrateUndo } from "@/components/celebrate";
import { celebrationMessage, momentFor, type ApplyProgress } from "@/lib/celebrate/moments";
import {
  setDismissedAction,
  setNotesAction,
  setSavedAction,
  setStatusAction,
  splitMergeAction,
} from "./actions";
import {
  isMutation,
  planMutation,
  runRowCommand,
  writeClipboard,
  type ActionRow,
  type DetailFocus,
  type RowActionDeps,
  type RowCommand,
  type SendResult,
  type ServerRequest,
  type SplitResult,
  type Toast,
} from "./row-actions";
import type { PatchMap, TableRow } from "./table-state";

type SendWithProgress = SendResult & { progress?: ApplyProgress };

/** Maps a resolved mutation to its Server Action. The one place that does. */
async function send(listingId: string, request: ServerRequest): Promise<SendWithProgress> {
  switch (request.kind) {
    case "status": {
      const res = await setStatusAction({ listingId, status: request.status as AppStatus });
      return res.ok ? { ok: true, progress: res.progress } : res;
    }
    case "saved":
      return setSavedAction({ listingId, value: request.value });
    case "dismissed":
      return setDismissedAction({ listingId, value: request.value });
  }
}

/** The one place a split reaches the server. */
async function sendSplit(
  listingId: string,
  source: string,
  sourceUid: string,
): Promise<SplitResult> {
  const res = await splitMergeAction({ listingId, source, sourceUid });
  return res.ok
    ? { ok: true, listingId: res.listingId, alreadySplit: res.alreadySplit, label: res.label }
    : res;
}

interface Options {
  notify: (toast: Toast) => void;
  openDetail: (listingId: string, focus?: DetailFocus) => void;
  /** A mutation or notes save for this listing was confirmed by the server. */
  onSettled: (listingId: string) => void;
  /** A merged-in record became its own listing (both listings changed). */
  onSplit: (parentId: string, newListingId: string) => void;
}

/** What a celebration reads off the row: the action fields, plus whether it's a dream role. */
export type CelebrationRow = ActionRow & Partial<Pick<TableRow, "score" | "faangPlus">>;

/**
 * Where a row's celebration starts: the control you just used, if it belongs
 * to this listing; else the row's status cell or the detail panel's status
 * controls, whichever is on screen (both carry `data-celebrate`).
 */
function celebrationOrigin(listingId: string): Element | null {
  const tagged = [...document.querySelectorAll(attrSelector("data-celebrate", listingId))];
  const active = document.activeElement;
  if (active && tagged.some((el) => el.contains(active))) return active;
  return (
    tagged.find((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.bottom > 0 && r.top < window.innerHeight;
    }) ?? null
  );
}

/**
 * The table's single entry point for acting on a row. Keyboard shortcuts, the
 * context menu and the detail panel all call `perform`; the optimistic overlay
 * lives here and nowhere else.
 */
export function useRowActions({ notify, openDetail, onSettled, onSplit }: Options) {
  const [patches, setPatchState] = useState<PatchMap>({});
  const patchesRef = useRef<PatchMap>(patches);

  const opts = useRef({ notify, openDetail, onSettled, onSplit });
  useLayoutEffect(() => {
    opts.current = { notify, openDetail, onSettled, onSplit };
  });

  const performRef = useRef<typeof perform | null>(null);
  const perform = useCallback(async (row: CelebrationRow, command: RowCommand, how: { quiet?: boolean } = {}) => {
    // The show starts on the key press, not the server's answer: the patch
    // is optimistic, and so is the confetti. A failed save reverts the row
    // and says so in the toast.
    const request = isMutation(command) ? planMutation(row, command).request : null;
    const moment =
      !how.quiet && request?.kind === "status" ? momentFor(row.statusKey, request.status) : null;
    const dream = (row.score ?? 0) >= 70 || row.saved || row.faangPlus === true;
    const origin = request && !how.quiet ? celebrationOrigin(row.id) : null;
    if (how.quiet) celebrateUndo();
    else if (moment) celebrate(moment, { origin, dream });
    else if (request?.kind === "saved" && request.value) celebrateSave(origin);
    else if (request?.kind === "dismissed" && request.value) celebrateDismiss(origin);

    let progress: ApplyProgress | undefined;
    const deps: RowActionDeps = {
      getPatches: () => patchesRef.current,
      setPatches: (next) => {
        patchesRef.current = next;
        setPatchState(next);
      },
      send: async (id, req) => {
        const res = await send(id, req);
        if (res.ok) progress = res.progress;
        return res;
      },
      notify: (t) => opts.current.notify(t),
      onSettled: (id) => opts.current.onSettled(id),
      openDetail: (id, focus) => opts.current.openDetail(id, focus),
      splitMerge: sendSplit,
      onSplit: (parentId, newId) => opts.current.onSplit(parentId, newId),
      openWindow: (href) => {
        window.open(href, "_blank", "noopener,noreferrer");
      },
      writeClipboard: (text) => writeClipboard(text),
    };
    const ok = await runRowCommand(row, command, deps);

    if (ok && moment && request?.kind === "status") {
      celebrateProgress(progress, { origin });
      const previous = row.statusKey;
      opts.current.notify({
        kind: "celebrate",
        message: celebrationMessage(moment, { company: row.company, dream, progress }),
        action: {
          label: "Undo",
          run: () => {
            void performRef.current?.({ ...row, statusKey: request.status }, { kind: "setStatus", status: previous }, { quiet: true });
          },
        },
      });
    }
    return ok;
  }, []);
  useLayoutEffect(() => {
    performRef.current = perform;
  });

  const saveNotes = useCallback(async (listingId: string, notes: string): Promise<SendResult> => {
    let res: SendResult;
    try {
      res = await setNotesAction({ listingId, notes });
    } catch (err) {
      res = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (res.ok) opts.current.onSettled(listingId);
    else opts.current.notify({ kind: "error", message: res.message });
    return res;
  }, []);

  return { patches, perform, saveNotes };
}
