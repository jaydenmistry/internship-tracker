"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth-guard";
import { saveLetterProfileFields, saveSignature } from "@/lib/coverletter/profile";
import { validateSignature } from "@/lib/coverletter/signature";
import { LetterProfileSchema, SIGNATURE_MAX_BYTES } from "@/lib/coverletter/profile-schema";

/**
 * Letterhead settings. Each action checks the session itself first (not
 * relying on proxy.ts) and validates its payload; nothing throws across the
 * boundary.
 */

export type ProfileResult = { ok: true } | { ok: false; message: string };

const fieldsSchema = LetterProfileSchema.omit({ signature: true }).extend({
  contactLines: z.array(z.string().trim().max(200)).max(3),
});

function failed(verb: string, err: unknown): ProfileResult {
  return { ok: false, message: `${verb} failed: ${err instanceof Error ? err.message : String(err)}` };
}

export async function saveLetterProfileAction(payload: unknown): Promise<ProfileResult> {
  await requireSession();
  const parsed = fieldsSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload" };
  }
  try {
    await saveLetterProfileFields({ ...parsed.data, contactLines: parsed.data.contactLines.filter(Boolean) });
  } catch (err) {
    return failed("Saving", err);
  }
  refresh();
  return { ok: true };
}

/**
 * The image is identified from its bytes (PNG or JPEG), never from the
 * browser-supplied type or name, and capped in size before it is read.
 */
export async function uploadSignatureAction(form: FormData): Promise<ProfileResult> {
  await requireSession();
  const file = form.get("signature");
  if (!(file instanceof File)) return { ok: false, message: "Choose an image file." };
  // Checked before the bytes are read.
  if (file.size > SIGNATURE_MAX_BYTES) {
    return { ok: false, message: `Signature images must be under ${Math.round(SIGNATURE_MAX_BYTES / 1024)} KB.` };
  }
  const checked = await validateSignature(new Uint8Array(await file.arrayBuffer()));
  if (!checked.ok) return checked;
  try {
    await saveSignature(checked.signature);
  } catch (err) {
    return failed("Saving the signature", err);
  }
  refresh();
  return { ok: true };
}

export async function removeSignatureAction(): Promise<ProfileResult> {
  await requireSession();
  try {
    await saveSignature(null);
  } catch (err) {
    return failed("Removing the signature", err);
  }
  refresh();
  return { ok: true };
}
