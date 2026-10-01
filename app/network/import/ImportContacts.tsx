"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import Badge from "@/components/Badge";
import { KIND_LABELS } from "@/lib/networking/schema";
import { analyzeContactImportAction, commitContactImportAction, type AnalyzeImportResult } from "../actions";
import { IMPORT_MAX_CHARS } from "@/lib/networking/import";
import { initialSelection, toggleRow } from "./state";

/**
 * /network/import — paste or upload, review, import.
 *
 * Nothing is saved until "Import". Duplicates (of saved contacts or of an
 * earlier row) start unticked. Every value shown came from the file and is
 * rendered as text.
 */

const EXAMPLE = `Name, Company, Title, Email, How met, Notes
Ada Example, Stripe, University Recruiter, ada@example.com, UGA career fair, Said reqs open in October
Grace Sample, Datadog, Software Engineer, , Alumni directory, Works on metrics ingestion`;

type Analysis = Extract<AnalyzeImportResult, { ok: true }>;

export default function ImportContacts() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ created: number; failed: Array<{ name: string; message: string }> } | null>(null);
  const [pending, startTransition] = useTransition();

  const count = selected.size;
  const dupes = useMemo(() => analysis?.rows.filter((r) => r.duplicate).length ?? 0, [analysis]);

  const onAnalyze = () => {
    setError(null);
    setDone(null);
    startTransition(async () => {
      let res: AnalyzeImportResult;
      try {
        res = await analyzeContactImportAction({ text });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (!res.ok) return setError(res.message);
      setAnalysis(res);
      setSelected(initialSelection(res.rows));
    });
  };

  const onImport = () => {
    if (!analysis) return;
    setError(null);
    const contacts = analysis.rows.filter((r) => selected.has(r.lineNumber)).map((r) => r.contact);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof commitContactImportAction>>;
      try {
        res = await commitContactImportAction({ contacts });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (!res.ok) {
        // Some rows may have been created before the failure. Re-read the
        // text so those now show as "already saved" (unticked) rather than
        // being imported a second time on retry.
        setError(`${res.message} — the list below was re-checked; anything already saved is now unticked.`);
        try {
          const again = await analyzeContactImportAction({ text });
          if (again.ok) {
            setAnalysis(again);
            setSelected(initialSelection(again.rows));
          } else {
            setAnalysis(null);
          }
        } catch {
          setAnalysis(null);
        }
        return;
      }
      setDone({ created: res.created, failed: res.failed });
      setAnalysis(null);
      setText("");
    });
  };

  return (
    <div className="flex max-w-6xl flex-col gap-3">
      <nav className="text-[12px] text-dim">
        <Link href="/network" className="hover:text-ink">
          ← Network
        </Link>
      </nav>
      <h1 className="text-[14px] font-medium">Import contacts</h1>

      {done && (
        <div role="status" className="rounded border border-ok/40 bg-ok/10 px-3 py-2 text-[13px]" data-testid="import-done">
          Imported {done.created} contact{done.created === 1 ? "" : "s"}.{" "}
          <Link href="/network" className="text-accent hover:underline">
            See them on Network
          </Link>
          {done.failed.length > 0 && (
            <ul className="mt-1 text-bad">
              {done.failed.map((f, i) => (
                <li key={i}>
                  {f.name}: {f.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!analysis && (
        <section className="rounded border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
            <span className="font-mono text-[11px] tracking-wide text-faint uppercase">paste or upload</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setText(EXAMPLE)}
                className="rounded px-2 py-0.5 text-[12px] text-dim hover:bg-raised hover:text-ink"
              >
                Load example
              </button>
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="rounded px-2 py-0.5 text-[12px] text-dim hover:bg-raised hover:text-ink"
              >
                Upload .csv
              </button>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  // Characters ≤ bytes, so a file this large can't fit the limit.
                  if (file.size > IMPORT_MAX_CHARS * 4) {
                    setError(`That file is ${(file.size / 1e6).toFixed(1)} MB — too large to import in one go. Split it.`);
                    return;
                  }
                  try {
                    // Read in the browser; the file itself is never uploaded.
                    setText(await file.text());
                  } catch (err) {
                    setError(err instanceof Error ? err.message : "could not read that file");
                  }
                }}
              />
            </div>
          </div>
          <textarea
            aria-label="Contacts to import"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            rows={12}
            placeholder={"Name, Company, Title, Email\nAda Example, Stripe, University Recruiter, ada@example.com"}
            className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[12px] leading-5 outline-none placeholder:text-faint"
          />
          <div className="flex items-center justify-between gap-3 border-t border-line-soft px-3 py-2">
            <p className="text-[11px] text-faint">
              First row names the columns, in any order: Name (or First Name + Last Name), Company, Title, Kind, Email,
              LinkedIn, How met, Notes. LinkedIn&apos;s own <span className="text-dim">Connections.csv</span> export works
              as is.
            </p>
            <button
              type="button"
              onClick={onAnalyze}
              disabled={pending || text.trim() === ""}
              className="shrink-0 rounded bg-accent px-3 py-1 text-[12px] font-medium text-accent-ink disabled:opacity-40"
            >
              {pending ? "Reading…" : "Review"}
            </button>
          </div>
        </section>
      )}

      {analysis && (
        <section className="flex flex-col gap-2" aria-label="Review">
          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            <span>
              {analysis.rows.length} row{analysis.rows.length === 1 ? "" : "s"} read
              {analysis.linkedInExport && " from a LinkedIn Connections export"}
              {dupes > 0 && `, ${dupes} look like duplicates (unticked)`}
              {analysis.errors.length > 0 && `, ${analysis.errors.length} skipped`}.
            </span>
            <button
              type="button"
              onClick={() => setAnalysis(null)}
              className="text-dim hover:text-ink"
              disabled={pending}
            >
              ← edit
            </button>
            <button
              type="button"
              onClick={onImport}
              disabled={pending || count === 0}
              className="ml-auto rounded bg-accent px-3 py-1 font-medium text-accent-ink disabled:opacity-40"
              data-testid="import-commit"
            >
              {pending ? "Importing…" : `Import ${count} contact${count === 1 ? "" : "s"}`}
            </button>
          </div>

          <div className="overflow-x-auto rounded border border-line bg-panel">
            <table className="w-full border-collapse text-[12px]" data-testid="import-review">
              <thead className="border-b border-line text-left text-[11px] text-faint">
                <tr>
                  <th className="w-8 px-2 py-1" />
                  <th className="px-2 py-1 font-normal">name</th>
                  <th className="px-2 py-1 font-normal">company</th>
                  <th className="px-2 py-1 font-normal">title</th>
                  <th className="px-2 py-1 font-normal">kind</th>
                  <th className="px-2 py-1 font-normal">email</th>
                  <th className="px-2 py-1 font-normal">how met</th>
                  <th className="px-2 py-1 font-normal" />
                </tr>
              </thead>
              <tbody>
                {analysis.rows.map((r) => (
                  <tr key={r.lineNumber} className="border-b border-line-soft align-top" data-testid="import-row">
                    <td className="px-2 py-1">
                      <input
                        type="checkbox"
                        aria-label={`Import ${r.contact.name}`}
                        checked={selected.has(r.lineNumber)}
                        onChange={() => setSelected((s) => toggleRow(s, r.lineNumber))}
                      />
                    </td>
                    <td className="px-2 py-1 font-medium">{r.contact.name}</td>
                    <td className="px-2 py-1 text-dim">{r.contact.company ?? "—"}</td>
                    <td className="px-2 py-1 text-dim">{r.contact.title ?? "—"}</td>
                    <td className="px-2 py-1 text-dim">{KIND_LABELS[r.contact.kind]}</td>
                    <td className="px-2 py-1 font-mono text-dim">{r.contact.email ?? "—"}</td>
                    <td className="px-2 py-1 text-dim">{r.contact.howMet ?? "—"}</td>
                    <td className="px-2 py-1">
                      {r.duplicate && (
                        <Badge
                          tone="warn"
                          title={
                            r.duplicate.kind === "existing"
                              ? `Already saved as ${r.duplicate.name} (${r.duplicate.reason})`
                              : `Same person as line ${r.duplicate.lineNumber} (${r.duplicate.reason})`
                          }
                        >
                          {r.duplicate.kind === "existing" ? "already saved" : "repeat"}
                        </Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {analysis.errors.length > 0 && (
            <details className="rounded border border-line bg-panel px-3 py-2 text-[12px]">
              <summary className="cursor-pointer text-warn">
                {analysis.errors.length} line{analysis.errors.length === 1 ? "" : "s"} skipped
              </summary>
              <ul className="mt-1 space-y-0.5">
                {analysis.errors.map((e, i) => (
                  <li key={i}>
                    <span className="font-mono text-faint">line {e.lineNumber}</span> {e.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {error && (
        <p role="alert" className="rounded border border-bad/40 bg-bad/10 px-3 py-2 text-[12px] text-bad">
          {error}
        </p>
      )}
    </div>
  );
}
