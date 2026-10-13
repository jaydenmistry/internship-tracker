import { PDFDocument } from "pdf-lib";
import { imageInfo } from "./image";
import { SIGNATURE_MAX_BYTES, type Signature } from "./profile-schema";

/**
 * Checks an uploaded signature image end to end, at upload time rather than
 * at the first export: identified from its bytes (PNG/JPEG), within the size
 * and pixel limits, and actually embeddable by pdf-lib — whose JPEG reader is
 * stricter than the sniffing in image.ts, so a file that passed the sniff
 * could otherwise fail every PDF export later.
 */
export async function validateSignature(
  bytes: Uint8Array,
): Promise<{ ok: true; signature: Signature } | { ok: false; message: string }> {
  if (bytes.length === 0) return { ok: false, message: "That file is empty." };
  if (bytes.length > SIGNATURE_MAX_BYTES) {
    return { ok: false, message: `Signature images must be under ${Math.round(SIGNATURE_MAX_BYTES / 1024)} KB.` };
  }
  const info = imageInfo(bytes);
  if (!info) return { ok: false, message: "Use a PNG or JPEG image, at most 4000 pixels on a side." };
  try {
    const pdf = await PDFDocument.create();
    if (info.mime === "image/png") await pdf.embedPng(bytes);
    else await pdf.embedJpg(bytes);
  } catch {
    return { ok: false, message: "That image can't be used in a PDF. Re-save it as a standard PNG or JPEG." };
  }
  return { ok: true, signature: { ...info, base64: Buffer.from(bytes).toString("base64") } };
}
