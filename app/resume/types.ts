/**
 * Shared types for the /resume upload flow. Kept out of actions.ts because a
 * `"use server"` module may only export async functions.
 */

/** Every distinct way an upload can fail, one per UI treatment. */
export type UploadErrorReason =
  | "no-file"
  | "empty"
  | "not-a-pdf"
  | "too-large"
  | "no-text"
  | "unreadable"
  | "failed";

export type UploadState =
  | { status: "idle" }
  | {
      status: "success";
      filename: string;
      chars: number;
      pages: number;
      /** The PDF's text ran past the stored-length cap and was cut. */
      truncated: boolean;
    }
  | { status: "error"; reason: UploadErrorReason; message: string };

export const IDLE_UPLOAD: UploadState = { status: "idle" };
