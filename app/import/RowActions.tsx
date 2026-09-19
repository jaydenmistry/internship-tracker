"use client";

import { useState, useTransition } from "react";
import { searchCatalog } from "./actions";
import { candidatesFor, hitToCandidate, type RowAction, type RowDecision } from "./state";
import type { ReviewCandidate, ReviewRow } from "./types";

interface Props {
  row: ReviewRow;
  decision: RowDecision;
  onSet: (action: RowAction, listingId?: string | null) => void;
}

/**
 * The one control that covers all four outcomes for a row: confirm the proposed
 * match, correct it (an alternative, or a listing found by hand), import it as a
 * manual application, or skip it.
 */
export default function RowActions({ row, decision, onSet }: Props) {
  const [extra, setExtra] = useState<ReviewCandidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ReviewCandidate[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const candidates = candidatesFor(row, extra);
  const value =
    decision.action === "link" && decision.listingId ? `link:${decision.listingId}` : decision.action;

  // Takes the term explicitly: an Enter pressed in the same tick as the last
  // keystroke would otherwise search the previous render's value.
  function runSearch(term: string) {
    if (term.trim().length < 2) return;
    startTransition(async () => {
      const result = await searchCatalog(term.trim());
      if (result.ok) {
        setHits(result.hits.map(hitToCandidate));
        setSearchError(null);
      } else {
        setHits(null);
        setSearchError(result.message);
      }
    });
  }

  function pick(candidate: ReviewCandidate) {
    setExtra((prev) =>
      prev.some((c) => c.listingId === candidate.listingId) ? prev : [...prev, candidate],
    );
    onSet("link", candidate.listingId);
    setSearching(false);
    setHits(null);
    setQuery("");
  }

  return (
    <div className="flex flex-col items-stretch gap-1">
      <div className="flex items-center gap-1">
        <select
          aria-label={`Action for line ${row.row.lineNumber}`}
          value={value}
          onChange={(e) => {
            const v = e.target.value;
            if (v.startsWith("link:")) onSet("link", v.slice(5));
            else onSet(v as RowAction);
          }}
          className="min-w-0 flex-1 rounded border border-line bg-raised px-1.5 py-1 text-[12px] text-ink"
        >
          {candidates.map((c, i) => (
            <option key={c.listingId} value={`link:${c.listingId}`}>
              {i === 0 && c === row.best ? "Link → " : "Link (alt) → "}
              {c.company} · {c.title}
            </option>
          ))}
          <option value="manual">Import as manual</option>
          <option value="skip">Skip</option>
        </select>
        <button
          type="button"
          title="Search the catalog for the right listing"
          onClick={() => setSearching((s) => !s)}
          className={`shrink-0 rounded border border-line px-1.5 py-1 text-[11px] ${
            searching ? "bg-accent text-accent-ink" : "bg-raised text-dim hover:text-ink"
          }`}
        >
          find
        </button>
      </div>

      {searching && (
        <div className="rounded border border-line bg-canvas p-1.5">
          <div className="flex gap-1">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  runSearch(e.currentTarget.value);
                }
                // Keep row navigation from firing while typing here.
                e.stopPropagation();
              }}
              placeholder="company or title…"
              className="min-w-0 flex-1 rounded border border-line bg-panel px-1.5 py-0.5 text-[12px] outline-none placeholder:text-faint"
            />
            <button
              type="button"
              onClick={() => runSearch(query)}
              disabled={pending}
              className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[11px] text-dim hover:text-ink disabled:opacity-40"
            >
              {pending ? "…" : "go"}
            </button>
          </div>

          {searchError && <p className="mt-1 text-[11px] text-bad">{searchError}</p>}
          {hits !== null && hits.length === 0 && (
            <p className="mt-1 text-[11px] text-faint">No listings matched.</p>
          )}
          {hits !== null && hits.length > 0 && (
            <ul className="mt-1 max-h-40 overflow-y-auto">
              {hits.map((hit) => (
                <li key={hit.listingId}>
                  <button
                    type="button"
                    onClick={() => pick(hit)}
                    className="block w-full rounded px-1 py-0.5 text-left text-[11px] leading-tight hover:bg-raised"
                  >
                    <span className="text-ink">{hit.company}</span>{" "}
                    <span className="text-dim">{hit.title}</span>
                    {hit.alreadyApplied && <span className="text-warn"> · already tracked</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
