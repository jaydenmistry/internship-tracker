"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AppStatus } from "@/generated/prisma/enums";
import RowActions from "./RowActions";
import {
  defaultDecision,
  formatConfidence,
  safeHttpUrl,
  verdictMeta,
  type DecisionEvent,
  type DecisionMap,
  type DecisionSummary,
  type RowAction,
} from "./state";
import type { ParseIssue, ReviewRow } from "./types";

interface Props {
  rows: ReviewRow[];
  issues: ParseIssue[];
  decisions: DecisionMap;
  dispatch: (event: DecisionEvent) => void;
  summary: DecisionSummary;
  status: AppStatus;
  onStatusChange: (status: AppStatus) => void;
  onCommit: () => void;
  onBack: () => void;
  pending: boolean;
  error: string | null;
}

const STATUS_LABELS: Record<AppStatus, string> = {
  NOT_APPLIED: "Not applied",
  APPLIED: "Applied",
  OA: "Online assessment",
  PHONE_SCREEN: "Phone screen",
  INTERVIEW: "Interview",
  OFFER: "Offer",
  REJECTED: "Rejected",
  CLOSED: "Closed",
  SKIPPED: "Skipped",
};

const SHORTCUTS: Array<[string, string]> = [
  ["j / ↓", "next row"],
  ["k / ↑", "previous row"],
  ["space", "include / exclude this row"],
  ["c", "confirm the proposed match"],
  ["m", "import as manual (no listing)"],
  ["s", "skip this row"],
  ["?", "toggle this cheat sheet"],
];

/** Typing in a field must never trigger a row shortcut. */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    target.isContentEditable
  );
}

export default function ReviewStep({
  rows,
  issues,
  decisions,
  dispatch,
  summary,
  status,
  onStatusChange,
  onCommit,
  onBack,
  pending,
  error,
}: Props) {
  const [focused, setFocused] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [issuesOpen, setIssuesOpen] = useState(true);
  const rowRefs = useRef<Array<HTMLTableRowElement | null>>([]);

  const move = useCallback(
    (delta: number) => {
      setFocused((current) => {
        const next = Math.min(rows.length - 1, Math.max(0, current + delta));
        rowRefs.current[next]?.focus();
        return next;
      });
    },
    [rows.length],
  );

  // The `?` cheat sheet is reachable from anywhere on the step, but never while
  // a field has focus and never on top of a browser or OS shortcut.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isEditable(e.target)) return;
      if (e.key === "?") {
        e.preventDefault();
        setShowHelp((s) => !s);
      } else if (e.key === "Escape" && showHelp) {
        setShowHelp(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showHelp]);

  function handleRowKey(e: React.KeyboardEvent, row: ReviewRow, index: number) {
    // Never shadow a browser or system shortcut, and never fire while typing.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isEditable(e.target)) return;

    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        move(1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        move(-1);
        break;
      case " ":
      case "Enter":
        e.preventDefault();
        dispatch({ type: "toggle", row });
        break;
      case "c":
        if (row.best) {
          e.preventDefault();
          dispatch({ type: "set", key: row.key, action: "link", listingId: row.best.listingId });
        }
        break;
      case "m":
        e.preventDefault();
        dispatch({ type: "set", key: row.key, action: "manual" });
        break;
      case "s":
        e.preventDefault();
        dispatch({ type: "set", key: row.key, action: "skip" });
        break;
      default:
        return;
    }
    setFocused(index);
  }

  const unmatched = rows.filter((r) => !r.best);
  const linkable = rows.filter((r) => r.best);

  return (
    <section className="flex w-full flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded border border-line bg-panel px-3 py-2">
        <button
          type="button"
          onClick={onBack}
          className="rounded px-2 py-1 text-[12px] text-dim hover:bg-raised hover:text-ink"
        >
          ← Edit paste
        </button>

        <p className="font-mono text-[12px]">
          <span className="text-ok">{summary.link} will link</span>
          <span className="text-faint"> · </span>
          <span className="text-info">{summary.manual} manual</span>
          <span className="text-faint"> · </span>
          <span className="text-faint">{summary.skip} skipped</span>
        </p>

        {summary.untouched > 0 && (
          <p className="text-[12px] text-warn">
            {summary.untouched} row{summary.untouched === 1 ? "" : "s"} still need a decision
          </p>
        )}

        <div className="ml-auto flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => dispatch({ type: "bulk", rows: linkable, action: "link" })}
            className="rounded border border-line bg-raised px-2 py-1 text-[11px] text-dim hover:text-ink"
          >
            Link all matched
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "bulk", rows: unmatched, action: "manual" })}
            disabled={unmatched.length === 0}
            className="rounded border border-line bg-raised px-2 py-1 text-[11px] text-dim hover:text-ink disabled:opacity-40"
          >
            Manual for {unmatched.length} unmatched
          </button>
          <button
            type="button"
            onClick={() => dispatch({ type: "bulk", rows, action: "skip" })}
            className="rounded border border-line bg-raised px-2 py-1 text-[11px] text-dim hover:text-ink"
          >
            Skip all
          </button>

          <label className="flex items-center gap-1 text-[11px] text-faint">
            status
            <select
              value={status}
              onChange={(e) => onStatusChange(e.target.value as AppStatus)}
              className="rounded border border-line bg-raised px-1.5 py-1 text-[12px] text-ink"
            >
              {Object.values(AppStatus).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            onClick={() => setShowHelp((s) => !s)}
            title="Keyboard shortcuts"
            className="rounded border border-line bg-raised px-2 py-1 font-mono text-[11px] text-dim hover:text-ink"
          >
            ?
          </button>

          <button
            type="button"
            onClick={onCommit}
            disabled={pending || summary.link + summary.manual === 0}
            className="rounded bg-accent px-3 py-1 font-medium text-accent-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Importing…" : `Import ${summary.link + summary.manual}`}
          </button>
        </div>
      </div>

      {showHelp && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded border border-line bg-panel px-3 py-2 sm:grid-cols-4">
          {SHORTCUTS.map(([key, description]) => (
            <div key={key} className="flex items-baseline gap-2">
              <dt className="min-w-14 font-mono text-[11px] text-accent">{key}</dt>
              <dd className="text-[11px] text-dim">{description}</dd>
            </div>
          ))}
        </dl>
      )}

      {error && (
        <p className="rounded border border-bad/40 bg-bad/10 px-3 py-2 text-bad">{error}</p>
      )}

      {issues.length > 0 && issuesOpen && (
        <div className="rounded border border-warn/40 bg-warn/10 px-3 py-2">
          <div className="flex items-start justify-between gap-3">
            <p className="text-[12px] font-medium text-warn">
              {issues.length} line{issues.length === 1 ? "" : "s"} could not be parsed and were
              left out
            </p>
            <button
              type="button"
              onClick={() => setIssuesOpen(false)}
              className="rounded px-1 text-[11px] text-warn hover:bg-warn/20"
            >
              dismiss
            </button>
          </div>
          <ul className="mt-1 space-y-0.5">
            {issues.map((issue) => (
              <li key={issue.lineNumber} className="font-mono text-[11px] text-dim">
                line {issue.lineNumber}: {issue.reason} — {issue.raw}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-hidden rounded border border-line">
        <table className="w-full table-fixed border-collapse">
          <thead>
            <tr className="bg-panel text-left font-mono text-[10px] tracking-wide text-faint uppercase">
              <th className="w-10 px-2 py-1.5 font-normal">#</th>
              <th className="w-[26%] px-2 py-1.5 font-normal">pasted</th>
              <th className="w-[32%] px-2 py-1.5 font-normal">proposed match</th>
              <th className="w-[24%] px-2 py-1.5 font-normal">confidence</th>
              <th className="px-2 py-1.5 font-normal">action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const decision = decisions[row.key] ?? defaultDecision(row);
              const meta = verdictMeta(row.verdict);
              const candidate =
                decision.action === "link" && decision.listingId
                  ? [row.best, ...row.alternatives].find(
                      (c) => c?.listingId === decision.listingId,
                    ) ?? row.best
                  : row.best;
              const href = safeHttpUrl(candidate?.url);
              const included = decision.action !== "skip";

              return (
                <tr
                  key={row.key}
                  ref={(el) => {
                    rowRefs.current[index] = el;
                  }}
                  tabIndex={index === focused ? 0 : -1}
                  onFocus={() => setFocused(index)}
                  onKeyDown={(e) => handleRowKey(e, row, index)}
                  className={`border-t border-line-soft align-top outline-none focus:bg-raised focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${
                    included ? "bg-canvas" : "bg-canvas/40 text-faint"
                  }`}
                >
                  <td className="px-2 py-1.5">
                    <span className="font-mono text-[11px] text-faint">{row.row.lineNumber}</span>
                  </td>

                  <td className="px-2 py-1.5">
                    <div className="truncate font-medium text-ink" title={row.row.company}>
                      {row.row.company}
                    </div>
                    <div className="truncate text-dim" title={row.row.role}>
                      {row.row.role}
                    </div>
                    {row.row.location && (
                      <div className="truncate text-[11px] text-faint">{row.row.location}</div>
                    )}
                  </td>

                  <td className="px-2 py-1.5">
                    {candidate ? (
                      <>
                        <div className="flex items-baseline gap-2">
                          <span className="truncate font-medium text-ink" title={candidate.company}>
                            {candidate.company}
                          </span>
                          <span className="ml-auto shrink-0 font-mono text-[11px] text-accent">
                            {candidate.score ?? "—"}
                          </span>
                        </div>
                        <div className="truncate text-dim" title={candidate.title}>
                          {candidate.title}
                        </div>
                        <div className="flex items-baseline gap-2 text-[11px] text-faint">
                          <span className="truncate">{candidate.location || "—"}</span>
                          {candidate.alreadyApplied && (
                            <span className="shrink-0 text-warn">already tracked</span>
                          )}
                          {href && (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="ml-auto shrink-0 text-dim underline decoration-dotted hover:text-accent"
                            >
                              open
                            </a>
                          )}
                        </div>
                      </>
                    ) : (
                      <span className="text-faint">no listing in the catalog</span>
                    )}
                  </td>

                  <td className="px-2 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className={`font-medium ${meta.textClass}`}>{meta.label}</span>
                      <span className="font-mono text-[11px] text-faint">
                        {formatConfidence(row.best?.confidence)}
                      </span>
                    </div>
                    <div className="mt-1 h-0.5 w-full rounded bg-raised">
                      <div
                        className={`h-full rounded ${meta.barClass}`}
                        style={{ width: `${Math.round((row.best?.confidence ?? 0) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-0.5 text-[11px] leading-tight text-faint">
                      {row.best ? row.best.reasons.join(" · ") : "nothing scored above the floor"}
                    </div>
                  </td>

                  <td className="px-2 py-1.5">
                    <RowActions
                      row={row}
                      decision={decision}
                      onSet={(action: RowAction, listingId?: string | null) =>
                        dispatch({ type: "set", key: row.key, action, listingId })
                      }
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
