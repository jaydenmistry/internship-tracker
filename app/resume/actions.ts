"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { MAX_PDF_BYTES, ResumeExtractError, formatBytes } from "@/lib/resume/extract";
import { saveResume } from "@/lib/resume/store";
import type { UploadErrorReason, UploadState } from "./types";

/**
 * Upload boundary for /resume.
 *
 * A Server Action is a public POST endpoint: the FormData entry is validated
 * with Zod before anything touches it, the size is re-checked here against the
 * real byte length, and the magic-byte check lives in `lib/resume/extract` so
 * the parser is never handed a non-PDF. Nothing throws across the boundary —
 * the client needs a plain state object to render the right error.
 *
 * `File.size` and the browser-declared MIME type are hints for a fast, friendly
 * rejection only; `extractResumeText` re-validates the actual bytes.
 */

const fileSchema = z.instanceof(File, { message: "Choose a PDF file to upload." });
// The browser sets this; treat it as an arbitrary untrusted string.
const filenameSchema = z.string().max(1000).catch("");

function fail(reason: UploadErrorReason, message: string): UploadState {
  return { status: "error", reason, message };
}

export async function uploadResumeAction(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const parsed = fileSchema.safeParse(formData.get("resume"));
  if (!parsed.success) {
    return fail("no-file", "Choose a PDF file to upload.");
  }
  const file = parsed.data;

  if (file.size === 0) {
    return fail("empty", "That file is empty.");
  }
  if (file.size > MAX_PDF_BYTES) {
    return fail(
      "too-large",
      `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_PDF_BYTES)}.`,
    );
  }

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch (err) {
    return fail("failed", `Could not read the upload: ${describe(err)}`);
  }

  try {
    const saved = await saveResume({
      filename: filenameSchema.parse(file.name),
      bytes,
    });
    // Re-render the page in the same round trip so the "current resume" card
    // and its keyword list come back from the server, not from this result.
    refresh();
    return {
      status: "success",
      filename: saved.filename,
      chars: saved.text.length,
      pages: saved.pages,
      truncated: saved.truncated,
    };
  } catch (err) {
    if (err instanceof ResumeExtractError) return fail(err.reason, err.message);
    return fail("failed", `Upload failed: ${describe(err)}`);
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
