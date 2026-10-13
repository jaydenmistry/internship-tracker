"use server";

import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";
import { DraftClientError } from "@/lib/claude/draftClient";
import {
  CoverLetterRefusedError,
  deleteCoverLetter,
  generateCoverLetter,
  saveCoverLetter,
  type CoverLetterView,
} from "@/lib/coverletter/letters";
import { COVER_LETTER_CAPS, COVER_LETTER_MAX, PASTED_POSTING_MAX } from "@/lib/coverletter/prompt";

/**
 * Cover-letter actions. A Server Action is a public POST endpoint, so each one
 * checks the session itself first (independently of proxy.ts) and validates
 * its payload with Zod. Nothing throws across the boundary.
 *
 * These don't refresh() the page: the editor holds the letter it just got
 * back, and the listing/tracker pages are dynamic, so they read fresh rows on
 * the next visit anyway.
 */

export type LetterResult =
  | { ok: true; letter: CoverLetterView }
  | { ok: false; message: string; kind?: DraftClientError["kind"] };

export type DeleteResult = { ok: true } | { ok: false; message: string };

const idSchema = z.string().min(1).max(100);

const targetSchema = z.union([
  z.object({ listingId: idSchema }).strict(),
  z.object({ applicationId: idSchema }).strict(),
]);

const generateSchema = z.object({
  target: targetSchema,
  source: z.enum(["listing", "pasted"]),
  postingText: z.string().max(PASTED_POSTING_MAX).nullable(),
  nudge: z.string().max(COVER_LETTER_CAPS.nudge).nullable(),
});

const saveSchema = z.object({
  target: targetSchema,
  body: z.string().max(COVER_LETTER_MAX),
  greeting: z.string().max(200),
  recipient: z.string().max(1000),
});

const deleteSchema = z.object({ target: targetSchema });

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

export async function generateCoverLetterAction(payload: unknown): Promise<LetterResult> {
  await requireSession();
  const parsed = generateSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    return { ok: true, letter: await generateCoverLetter(parsed.data) };
  } catch (err) {
    if (err instanceof CoverLetterRefusedError) return { ok: false, message: err.message };
    if (err instanceof DraftClientError) {
      const message =
        err.kind === "NotAuthenticated"
          ? `Claude not connected: ${err.message} See /network/settings.`
          : err.kind === "UsageLimited"
            ? `${err.message}${err.resetsAt ? ` It resets ${err.resetsAt.toISOString()}.` : ""} You can still write the letter by hand.`
            : err.message;
      return { ok: false, message, kind: err.kind };
    }
    return failed("Drafting the letter", err);
  }
}

export async function saveCoverLetterAction(payload: unknown): Promise<LetterResult> {
  await requireSession();
  const parsed = saveSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { target, ...edits } = parsed.data;
    return { ok: true, letter: await saveCoverLetter(target, edits) };
  } catch (err) {
    if (err instanceof CoverLetterRefusedError) return { ok: false, message: err.message };
    return failed("Saving the letter", err);
  }
}

export async function deleteCoverLetterAction(payload: unknown): Promise<DeleteResult> {
  await requireSession();
  const parsed = deleteSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await deleteCoverLetter(parsed.data.target);
    return { ok: true };
  } catch (err) {
    return failed("Deleting the letter", err);
  }
}
