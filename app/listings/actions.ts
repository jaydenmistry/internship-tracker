"use server";

import { z } from "zod";
import { AppStatus } from "@/generated/prisma/enums";
import {
  setListingDismissed,
  setListingSaved,
  setListingStatus,
} from "@/lib/listings/mutations";

/**
 * Row actions from the main table.
 *
 * A Server Action is a public POST endpoint, so every payload is untrusted and
 * validated with Zod first. Nothing here throws across the boundary: the table
 * updates optimistically on key press and needs a plain `ok: false` to revert
 * the row, not an exception that blanks the view.
 *
 * These intentionally do NOT revalidate the page. The table's payload is the
 * whole ~2,900-row catalog; re-fetching it after every `a`/`s`/`d` keystroke
 * would be far slower than the optimistic patch the client already holds, and
 * `/` is dynamic, so the next navigation reads fresh rows anyway.
 */

export type ActionResult<T = unknown> =
  | ({ ok: true } & (T extends object ? T : object))
  | { ok: false; message: string };

const listingIdSchema = z.string().min(1).max(100);

const statusSchema = z.object({
  listingId: listingIdSchema,
  status: z.enum(AppStatus),
});

const flagSchema = z.object({
  listingId: listingIdSchema,
  value: z.boolean(),
});

function invalid(error: z.ZodError): { ok: false; message: string } {
  const issue = error.issues[0];
  return {
    ok: false,
    message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload",
  };
}

function failed(verb: string, err: unknown): { ok: false; message: string } {
  return {
    ok: false,
    message: `${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
  };
}

export async function setStatusAction(
  payload: unknown,
): Promise<ActionResult<{ status: AppStatus | null }>> {
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    // NOT_APPLIED removes the tracking row and comes back as `status: null`,
    // which is what the table stores for "no Application row yet".
    const { status } = await setListingStatus(parsed.data.listingId, parsed.data.status);
    return { ok: true, status };
  } catch (err) {
    return failed("Status change", err);
  }
}

export async function setSavedAction(payload: unknown): Promise<ActionResult> {
  const parsed = flagSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setListingSaved(parsed.data.listingId, parsed.data.value);
    return { ok: true };
  } catch (err) {
    return failed("Save", err);
  }
}

export async function setDismissedAction(payload: unknown): Promise<ActionResult> {
  const parsed = flagSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setListingDismissed(parsed.data.listingId, parsed.data.value);
    return { ok: true };
  } catch (err) {
    return failed("Dismiss", err);
  }
}
