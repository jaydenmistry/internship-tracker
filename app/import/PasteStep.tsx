"use client";

import { useRef, useState } from "react";

const EXAMPLE = `Company, Role, Location
Robinhood, Software Engineer Intern - Backend, Menlo Park CA
Amazon, Software Development Engineer Intern, Seattle WA
Datadog, Backend Engineer Intern, New York NY
Some Startup That Does Not Exist, Platform Engineer Intern, Atlanta GA`;

interface Props {
  text: string;
  onTextChange: (text: string) => void;
  onAnalyze: () => void;
  pending: boolean;
  error: string | null;
}

export default function PasteStep({
  text,
  onTextChange,
  onAnalyze,
  pending,
  error,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | null>(null);

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setFileError(null);
    try {
      // Read in the browser and feed the same string to the same parser — the
      // file never needs to be uploaded.
      onTextChange(await file.text());
    } catch (err) {
      setFileError(err instanceof Error ? err.message : "could not read that file");
    }
  }

  const lineCount = text.trim() ? text.trim().split(/\r?\n/).length : 0;

  return (
    <section className="mx-auto w-full max-w-3xl">
      <h1 className="text-base font-semibold tracking-tight">Import applications</h1>
      <p className="mt-1 max-w-prose text-dim">
        Paste the roles you have already applied to. They get matched against the
        ranked catalog so they stop showing up as new.
      </p>

      <div className="mt-4 rounded border border-line bg-panel">
        <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
          <span className="font-mono text-[11px] tracking-wide text-faint uppercase">
            paste or upload
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onTextChange(EXAMPLE)}
              className="rounded px-2 py-0.5 text-[12px] text-dim hover:bg-raised hover:text-ink"
            >
              Load example
            </button>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="rounded px-2 py-0.5 text-[12px] text-dim hover:bg-raised hover:text-ink"
            >
              Upload .csv / .txt
            </button>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              className="hidden"
              onChange={(e) => {
                void handleFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </div>
        </div>

        <textarea
          value={text}
          onChange={(e) => onTextChange(e.target.value)}
          spellCheck={false}
          rows={14}
          placeholder={"Company, Role, Location\nStripe, Software Engineer Intern, Seattle WA"}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-5 text-ink outline-none placeholder:text-faint"
        />

        <div className="flex items-center justify-between gap-3 border-t border-line-soft px-3 py-2">
          <p className="text-[11px] text-faint">
            One role per line. A header row in any column order, or positional{" "}
            <code className="font-mono text-dim">Company, Role, Location, ReqId, Url</code>.
            Commas, tabs, pipes or dashes all work.
          </p>
          <button
            type="button"
            onClick={onAnalyze}
            disabled={pending || lineCount === 0}
            className="shrink-0 rounded bg-accent px-3 py-1 font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Matching…" : `Match ${lineCount || ""} line${lineCount === 1 ? "" : "s"}`}
          </button>
        </div>
      </div>

      {(error || fileError) && (
        <p className="mt-3 rounded border border-bad/40 bg-bad/10 px-3 py-2 text-bad">
          {error ?? fileError}
        </p>
      )}
    </section>
  );
}
