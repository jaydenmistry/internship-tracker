"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth-guard";
import { addBoard, retryAllPaused, retryBoard, setBoardMuted } from "@/lib/ingestion/boards/store";

/**
 * Server boundary for /boards. Every action is a public POST endpoint, so the
 * session is checked first and each payload is validated before anything is
 * written. Nothing throws across the boundary; the client shows the message.
 */

export type BoardsActionResult = { ok: true; message: string } | { ok: false; message: string };

const AddSchema = z.object({
  url: z.string().trim().min(1, "Paste a link to the board").max(500),
  companyName: z.string().trim().max(120).optional(),
});

export async function addBoardAction(payload: unknown): Promise<BoardsActionResult> {
  await requireSession();
  const parsed = AddSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? "Invalid input" };
  try {
    const result = await addBoard(parsed.data.url, parsed.data.companyName || undefined);
    if (!result.ok) return result;
    refresh();
    return {
      ok: true,
      message: result.created
        ? `Watching ${result.companyName}. It's checked on the next refresh.`
        : `${result.companyName} is watched.`,
    };
  } catch (err) {
    return { ok: false, message: `Couldn't save the board: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const IdSchema = z.object({ id: z.string().min(1).max(64) });

export async function setBoardWatchedAction(payload: unknown): Promise<BoardsActionResult> {
  await requireSession();
  const parsed = IdSchema.extend({ watched: z.boolean() }).safeParse(payload);
  if (!parsed.success) return { ok: false, message: "Invalid input" };
  try {
    await setBoardMuted(parsed.data.id, !parsed.data.watched);
    refresh();
    return { ok: true, message: parsed.data.watched ? "Watching again." : "Stopped watching." };
  } catch {
    return { ok: false, message: "Couldn't update that board." };
  }
}

export async function retryBoardAction(payload: unknown): Promise<BoardsActionResult> {
  await requireSession();
  const parsed = IdSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, message: "Invalid input" };
  try {
    await retryBoard(parsed.data.id);
    refresh();
    return { ok: true, message: "It's checked again on the next refresh." };
  } catch {
    return { ok: false, message: "Couldn't update that board." };
  }
}

export async function retryAllPausedAction(): Promise<BoardsActionResult> {
  await requireSession();
  try {
    const count = await retryAllPaused();
    refresh();
    return { ok: true, message: `${count} board${count === 1 ? "" : "s"} will be checked again on the next refresh.` };
  } catch {
    return { ok: false, message: "Couldn't update the boards." };
  }
}
