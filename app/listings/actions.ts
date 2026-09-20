"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { AppStatus } from "@/generated/prisma/enums";
import { NOTES_MAX } from "./row-actions";
import { loadListingDetail, type ListingDetail } from "@/lib/listings/detail";
import { splitMerge } from "@/lib/ingestion/split";
import {
  setListingDismissed,
  setListingNotes,
  setListingSaved,
  setListingStatus,
} from "@/lib/listings/mutations";
import { requireSession } from "@/lib/auth-guard";

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

const detailSchema = z.object({ listingId: listingIdSchema });

const notesSchema = z.object({
  listingId: listingIdSchema,
  notes: z.string().max(NOTES_MAX),
});

const flagSchema = z.object({
  listingId: listingIdSchema,
  value: z.boolean(),
});

const splitSchema = z.object({
  listingId: listingIdSchema,
  source: z.string().min(1).max(100),
  sourceUid: z.string().min(1).max(500),
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
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = statusSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    // NOT_APPLIED comes back as `null` (row removed) or "NOT_APPLIED" (row kept
    // because it holds notes). The table treats both as "not applied".
    const { status } = await setListingStatus(parsed.data.listingId, parsed.data.status);
    return { ok: true, status };
  } catch (err) {
    return failed("Status change", err);
  }
}

export async function setSavedAction(payload: unknown): Promise<ActionResult> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
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
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = flagSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setListingDismissed(parsed.data.listingId, parsed.data.value);
    return { ok: true };
  } catch (err) {
    return failed("Dismiss", err);
  }
}

/**
 * The detail panel's on-demand read. Returns the panel's read model only —
 * `loadListingDetail` already shapes it to what the panel renders.
 */
export async function loadDetailAction(
  payload: unknown,
): Promise<ActionResult<{ detail: ListingDetail | null }>> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = detailSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    return { ok: true, detail: await loadListingDetail(parsed.data.listingId) };
  } catch (err) {
    return failed("Loading the listing", err);
  }
}

export async function setNotesAction(payload: unknown): Promise<ActionResult> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = notesSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    await setListingNotes(parsed.data.listingId, parsed.data.notes);
    return { ok: true };
  } catch (err) {
    return failed("Saving notes", err);
  }
}

/**
 * Splits one merged-in source record back out into its own listing.
 *
 * Unlike the row toggles above this one DOES refresh: it creates a row and
 * removes an entry, and a wrong merge hides a real listing — the table has to
 * show the recovered listing immediately, not on the next navigation.
 * `refresh()` (Next 16) re-runs the page's Server Component from inside the
 * action, so one round trip covers both.
 */
export async function splitMergeAction(
  payload: unknown,
): Promise<ActionResult<{ listingId: string; alreadySplit: boolean; label: string }>> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = splitSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  let result: Awaited<ReturnType<typeof splitMerge>>;
  try {
    result = await splitMerge(parsed.data);
  } catch (err) {
    return failed("Split", err);
  }
  if (!result.ok) return { ok: false, message: result.message };

  if (!result.alreadySplit) refresh();
  return {
    ok: true,
    listingId: result.listingId,
    alreadySplit: result.alreadySplit,
    label: `${result.company} — ${result.title}`,
  };
}
