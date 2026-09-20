"use client";

import { useActionState, useRef, useState } from "react";
import { MAX_PDF_BYTES, formatBytes } from "@/lib/resume/limits";
import { uploadResumeAction } from "./actions";
import { IDLE_UPLOAD, type UploadErrorReason, type UploadState } from "./types";

/**
 * The upload form. Client-side checks here are courtesy only — they save a
 * round trip on the obvious mistakes; `uploadResumeAction` re-validates size,
 * magic bytes and extractability server-side regardless of what arrives.
 */

const ERROR_TITLES: Record<UploadErrorReason, string> = {
  "no-file": "No file chosen",
  empty: "Empty file",
  "not-a-pdf": "Not a PDF",
  "too-large": "File too large",
  "no-text": "No readable text",
  unreadable: "Could not read that PDF",
  failed: "Upload failed",
};

interface Props {
  /** Changes the button wording when there is already a resume on file. */
  replacing: boolean;
}

export default function UploadForm({ replacing }: Props) {
  const [state, formAction, pending] = useActionState(uploadResumeAction, IDLE_UPLOAD);
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function handlePick(file: File | undefined) {
    setLocalError(null);
    if (!file) {
      setPicked(null);
      return;
    }
    setPicked({ name: file.name, size: file.size });
    if (file.size > MAX_PDF_BYTES) {
      setLocalError(
        `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_PDF_BYTES)}.`,
      );
    } else if (!/\.pdf$/i.test(file.name)) {
      setLocalError("That does not look like a PDF. Export your resume as a PDF first.");
    }
  }

  const blocked = localError !== null;

  return (
    <section className="rounded border border-line bg-panel">
      <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
        <span className="font-mono text-[11px] tracking-wide text-faint uppercase">
          {replacing ? "replace resume" : "upload resume"}
        </span>
        <span className="text-[11px] text-faint">PDF, up to {formatBytes(MAX_PDF_BYTES)}</span>
      </div>

      <form
        action={formAction}
        // React resets an uncontrolled `<form action={…}>` once the action
        // settles, so the file input is genuinely empty again afterwards. Drop
        // our summary of it on submit rather than letting the form go on
        // claiming to hold a file that the next submit would not post.
        onSubmit={() => {
          setPicked(null);
          setLocalError(null);
        }}
        className="flex flex-wrap items-center gap-2 px-3 py-3"
      >
        <input
          ref={inputRef}
          type="file"
          name="resume"
          required
          accept="application/pdf,.pdf"
          onChange={(e) => handlePick(e.target.files?.[0])}
          className="min-w-0 flex-1 cursor-pointer rounded border border-line bg-raised px-2 py-1 text-[12px] text-dim file:mr-2 file:cursor-pointer file:rounded-sm file:border-0 file:bg-panel file:px-2 file:py-0.5 file:text-[12px] file:text-ink hover:border-faint"
        />
        <button
          type="submit"
          disabled={pending || blocked}
          className="shrink-0 rounded bg-accent px-3 py-1 font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Reading PDF…" : replacing ? "Replace" : "Upload"}
        </button>
        {picked && !pending && (
          <button
            type="button"
            onClick={() => {
              if (inputRef.current) inputRef.current.value = "";
              setPicked(null);
              setLocalError(null);
            }}
            className="shrink-0 rounded px-2 py-1 text-[12px] text-dim hover:bg-raised hover:text-ink"
          >
            Clear
          </button>
        )}
      </form>

      {picked && !localError && (
        <p className="px-3 pb-2 text-[11px] text-faint">
          <span className="font-mono">{picked.name}</span> · {formatBytes(picked.size)}
        </p>
      )}

      <Result state={state} localError={localError} />

      <p className="border-t border-line-soft px-3 py-2 text-[11px] text-faint">
        The PDF is read once, here — only the extracted text is stored, and only
        for keyword matching. It never affects a listing&apos;s score.
      </p>
    </section>
  );
}

function Result({ state, localError }: { state: UploadState; localError: string | null }) {
  if (localError) {
    return (
      <p className="mx-3 mb-3 rounded border border-warn/40 bg-warn/10 px-3 py-2 text-warn">
        {localError}
      </p>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mx-3 mb-3 rounded border border-bad/40 bg-bad/10 px-3 py-2">
        <p className="font-medium text-bad">{ERROR_TITLES[state.reason]}</p>
        <p className="mt-0.5 text-dim">{state.message}</p>
      </div>
    );
  }

  if (state.status === "success") {
    return (
      <div className="mx-3 mb-3 rounded border border-ok/40 bg-ok/10 px-3 py-2">
        <p className="text-ok">
          Stored <span className="font-mono">{state.filename}</span> —{" "}
          {state.chars.toLocaleString("en-US")} characters from {state.pages}{" "}
          {state.pages === 1 ? "page" : "pages"}.
        </p>
        {state.truncated && (
          <p className="mt-0.5 text-[11px] text-dim">
            The text was longer than the stored limit and was cut at the cap.
          </p>
        )}
      </div>
    );
  }

  return null;
}
