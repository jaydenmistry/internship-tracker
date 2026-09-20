/**
 * Upload limits and byte formatting, in their own module with no dependencies.
 *
 * `lib/resume/extract.ts` pulls in pdf.js, which must never reach the browser
 * bundle — the upload form needs these numbers client-side for a friendly
 * pre-check, so they live here and both sides import the same constants.
 * The client check is UX only; the server re-validates every byte.
 */

/** Upload cap. A text resume is tens of KB; 10 MB is already absurdly generous. */
export const MAX_PDF_BYTES = 10 * 1024 * 1024;

/** Stored text cap. Matching only needs keywords, not a whole book. */
export const MAX_RESUME_CHARS = 200_000;

export function formatBytes(byteLength: number): string {
  if (byteLength < 1024) return `${byteLength} B`;
  if (byteLength < 1024 * 1024) return `${Math.round(byteLength / 1024)} KB`;
  return `${(byteLength / (1024 * 1024)).toFixed(1)} MB`;
}
