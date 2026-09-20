"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import {
  setDismissedAction,
  setNotesAction,
  setSavedAction,
  setStatusAction,
  splitMergeAction,
} from "./actions";
import {
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
import type { PatchMap } from "./table-state";

/** Maps a resolved mutation to its Server Action. The one place that does. */
async function send(listingId: string, request: ServerRequest): Promise<SendResult> {
  switch (request.kind) {
    case "status": {
      const res = await setStatusAction({ listingId, status: request.status as AppStatus });
      return res.ok ? { ok: true } : res;
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

  const perform = useCallback((row: ActionRow, command: RowCommand) => {
    const deps: RowActionDeps = {
      getPatches: () => patchesRef.current,
      setPatches: (next) => {
        patchesRef.current = next;
        setPatchState(next);
      },
      send,
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
    return runRowCommand(row, command, deps);
  }, []);

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
