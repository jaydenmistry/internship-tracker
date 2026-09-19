"use client";

import { useMemo, useReducer, useState, useTransition } from "react";
import Link from "next/link";
import { AppStatus } from "@/generated/prisma/enums";
import type { CommitSummary } from "@/lib/applications/commit";
import PasteStep from "./PasteStep";
import ReviewStep from "./ReviewStep";
import {
  buildCommitPayload,
  decisionsReducer,
  summarize,
  type DecisionMap,
} from "./state";
import { analyzeImport, commitImportRows } from "./actions";
import type { ParseIssue, ReviewRow } from "./types";

type Step = "paste" | "review" | "done";

export default function ImportFlow() {
  const [step, setStep] = useState<Step>("paste");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<ReviewRow[]>([]);
  const [issues, setIssues] = useState<ParseIssue[]>([]);
  const [status, setStatus] = useState<AppStatus>(AppStatus.APPLIED);
  const [result, setResult] = useState<CommitSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisions, dispatch] = useReducer(decisionsReducer, {} as DecisionMap);
  const [pending, startTransition] = useTransition();

  const summary = useMemo(() => summarize(rows, decisions), [rows, decisions]);

  function analyze() {
    setError(null);
    startTransition(async () => {
      const response = await analyzeImport(text);
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setRows(response.rows);
      setIssues(response.issues);
      dispatch({ type: "reset", rows: response.rows });
      setStep("review");
    });
  }

  function commit() {
    setError(null);
    const payload = buildCommitPayload(rows, decisions);
    if (payload.length === 0) {
      setError("Nothing selected — confirm at least one row first.");
      return;
    }
    startTransition(async () => {
      const response = await commitImportRows({ rows: payload, status });
      if (!response.ok) {
        setError(response.message);
        return;
      }
      setResult(response.summary);
      setStep("done");
    });
  }

  function restart() {
    setStep("paste");
    setText("");
    setRows([]);
    setIssues([]);
    setResult(null);
    setError(null);
    dispatch({ type: "reset", rows: [] });
  }

  if (step === "paste") {
    return (
      <PasteStep
        text={text}
        onTextChange={setText}
        onAnalyze={analyze}
        pending={pending}
        error={error}
      />
    );
  }

  if (step === "review") {
    return (
      <ReviewStep
        rows={rows}
        issues={issues}
        decisions={decisions}
        dispatch={dispatch}
        summary={summary}
        status={status}
        onStatusChange={setStatus}
        onCommit={commit}
        onBack={() => setStep("paste")}
        pending={pending}
        error={error}
      />
    );
  }

  return (
    <section className="mx-auto w-full max-w-2xl">
      <h1 className="text-base font-semibold tracking-tight">Import complete</h1>
      <dl className="mt-3 grid grid-cols-4 gap-2">
        {(
          [
            ["linked to listings", result?.linked ?? 0, "text-ok"],
            ["manual applications", result?.manual ?? 0, "text-info"],
            ["status updated", result?.updated ?? 0, "text-dim"],
            ["already tracked", result?.unchanged ?? 0, "text-faint"],
          ] as const
        ).map(([label, value, tone]) => (
          <div key={label} className="rounded border border-line bg-panel px-3 py-2">
            <dd className={`font-mono text-xl ${tone}`}>{value}</dd>
            <dt className="text-[11px] text-faint">{label}</dt>
          </div>
        ))}
      </dl>

      {result && result.failed.length > 0 && (
        <div className="mt-3 rounded border border-bad/40 bg-bad/10 px-3 py-2">
          <p className="text-[12px] font-medium text-bad">
            {result.failed.length} row{result.failed.length === 1 ? "" : "s"} failed
          </p>
          <ul className="mt-1 space-y-0.5">
            {result.failed.map((failure) => (
              <li key={failure.lineNumber} className="font-mono text-[11px] text-dim">
                line {failure.lineNumber}: {failure.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={restart}
          className="rounded bg-accent px-3 py-1 font-medium text-accent-ink"
        >
          Import more
        </button>
        <Link
          href="/"
          className="rounded border border-line bg-raised px-3 py-1 text-dim hover:text-ink"
        >
          Back to listings
        </Link>
      </div>
    </section>
  );
}
