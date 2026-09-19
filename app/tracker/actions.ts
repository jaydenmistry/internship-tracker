"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { AppStatus } from "@/generated/prisma/enums";
import { MAX_NOTES } from "./state";
import { setApplicationNotes, setApplicationStatus } from "@/lib/applications/tracker";

/**
 * Mutations from /tracker. A Server Action is a public POST endpoint, so every
 * payload is validated with Zod first, and nothing throws across the boundary:
 * the client applied the change optimistically and needs a plain `ok: false`
 * to revert it (status) or keep the unsaved text (notes).
 */

export type TrackerActionResult = { ok: true } | { ok: false; message: string };

const idSchema = z.string().min(1).max(100);

const statusSchema = z.object({
  applicationId: idSchema,
  status: z.enum(AppStatus),
});

const notesSchema = z.object({
  applicationId: idSchema,
  notes: z.string().max(MAX_NOTES, `notes are limited to ${MAX_NOTES} characters`),
});

function invalid(error: z.ZodError): { ok: false; message: string } {
  const issue = error.issues[0];
  return {
    ok: false,
    message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload",
  };
}

function failed(verb: string, err: unknown): { ok: false; message: string } {
  return { ok: false, message: `${verb} failed: ${err instanceof Error ? err.message : String(err)}` };
}

export async function setTrackerStatusAction(payload: unknown): Promise<TrackerActionResult> {
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await setApplicationStatus(parsed.data.applicationId, parsed.data.status);
  } catch (err) {
    return failed("status change", err);
  }
  // Re-render /tracker in the same round trip so the dashboard counts and the
  // server copy of the applications replace the optimistic overlay together.
  refresh();
  return { ok: true };
}

export async function setTrackerNotesAction(payload: unknown): Promise<TrackerActionResult> {
  const parsed = notesSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await setApplicationNotes(parsed.data.applicationId, parsed.data.notes);
  } catch (err) {
    return failed("saving notes", err);
  }
  // No refresh: notes don't feed the dashboard, and the client already holds
  // the saved text. Skipping it keeps an in-progress edit elsewhere untouched.
  return { ok: true };
}
