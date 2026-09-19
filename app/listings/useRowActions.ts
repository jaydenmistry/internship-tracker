"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import { setDismissedAction, setNotesAction, setSavedAction, setStatusAction } from "./actions";
import {
  runRowCommand,
  writeClipboard,
  type ActionRow,
  type RowActionDeps,
  type RowCommand,
  type SendResult,
  type ServerRequest,
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

interface Options {
  notify: (toast: Toast) => void;
  openDetail: (listingId: string) => void;
  /** A mutation or notes save for this listing was confirmed by the server. */
  onSettled: (listingId: string) => void;
}

/**
 * The table's single entry point for acting on a row. Keyboard shortcuts, the
 * context menu and the detail panel all call `perform`; the optimistic overlay
 * lives here and nowhere else.
 */
export function useRowActions({ notify, openDetail, onSettled }: Options) {
  const [patches, setPatchState] = useState<PatchMap>({});
  const patchesRef = useRef<PatchMap>(patches);

  const opts = useRef({ notify, openDetail, onSettled });
  useLayoutEffect(() => {
    opts.current = { notify, openDetail, onSettled };
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
      openDetail: (id) => opts.current.openDetail(id),
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
