"use client";

import { useMemo, useState, useTransition } from "react";
import { ExternalLink, Search } from "lucide-react";
import type { BoardRow } from "@/lib/ingestion/boards/store";
import {
  addBoardAction,
  retryAllPausedAction,
  retryBoardAction,
  setBoardWatchedAction,
  type BoardsActionResult,
} from "./actions";

/**
 * /boards — every watched company board, how its last check went, and what it
 * has found. Problems (a board that failed or was paused) sort to the top of
 * their own filter, so a broken board doesn't hide in a list of hundreds.
 */

type Filter = "all" | "watching" | "problems" | "stopped";

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "watching", label: "Watching" },
  { id: "problems", label: "Problems" },
  { id: "stopped", label: "Stopped" },
];

function hasProblem(b: BoardRow): boolean {
  return !b.muted && (b.paused || (b.lastStatus !== null && b.lastStatus !== "ok"));
}

function matches(b: BoardRow, filter: Filter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "watching":
      return !b.muted;
    case "problems":
      return hasProblem(b);
    case "stopped":
      return b.muted;
  }
}

function statusText(status: string): string {
  if (status === "ok") return "OK";
  if (status === "http_404") return "Board not found";
  if (status === "robots_denied") return "Blocked by robots.txt";
  if (status === "parse_failed") return "Unreadable response";
  if (status === "fetch_failed") return "Couldn't connect";
  if (status === "unsupported_url") return "Not a public address";
  const code = /^http_(\d+)$/.exec(status);
  return code ? `Error ${code[1]}` : status;
}

function ago(iso: string, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function BoardsView({ boards, pauseAfter }: { boards: BoardRow[]; pauseAfter: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  // Read once per render pass for "2h ago"; the page re-renders on every action.
  const [nowMs] = useState(() => Date.now());

  const watching = boards.filter((b) => !b.muted);
  const problems = boards.filter(hasProblem);
  const paused = boards.filter((b) => b.paused).length;
  const internships = watching.reduce((n, b) => n + (b.lastInternCount ?? 0), 0);
  const counts: Record<Filter, number> = {
    all: boards.length,
    watching: watching.length,
    problems: problems.length,
    stopped: boards.length - watching.length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards
      .filter((b) => matches(b, filter))
      .filter((b) => !q || b.companyName.toLowerCase().includes(q) || b.slug.toLowerCase().includes(q));
  }, [boards, filter, query]);

  const run = (action: () => Promise<BoardsActionResult>, after?: () => void) => {
    startTransition(async () => {
      const result = await action();
      setNotice({ tone: result.ok ? "ok" : "bad", text: result.message });
      if (result.ok) after?.();
    });
  };

  const onAdd = (e: React.FormEvent) => {
    e.preventDefault();
    run(
      () => addBoardAction({ url, companyName: name }),
      () => {
        setUrl("");
        setName("");
      },
    );
  };

  return (
    <div className="flex max-w-5xl flex-col gap-4">
      <p className="text-callout text-dim">
        <span className="font-semibold text-ink tabular-nums">{watching.length}</span> board
        {watching.length === 1 ? "" : "s"} watched ·{" "}
        <span className="font-semibold text-ink tabular-nums">{internships}</span> internship
        {internships === 1 ? "" : "s"} on their last check
        {problems.length > 0 && (
          <>
            {" "}
            ·{" "}
            <button type="button" className="font-semibold text-warn hover:underline" onClick={() => setFilter("problems")}>
              {problems.length} need{problems.length === 1 ? "s" : ""} attention
            </button>
          </>
        )}
        {paused > 1 && (
          <>
            {" "}
            ·{" "}
            <button
              type="button"
              disabled={pending}
              className="font-semibold text-accent hover:underline"
              onClick={() => run(() => retryAllPausedAction())}
            >
              Retry all {paused} paused
            </button>
          </>
        )}
      </p>

      <section className="card" aria-labelledby="add-board">
        <h2 id="add-board" className="border-b border-line-soft px-4 py-2.5 text-body font-semibold">
          Watch a board
        </h2>
        <form onSubmit={onAdd} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-end">
          <label className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-callout text-dim">Link to the board or any job on it</span>
            <input
              type="url"
              required
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://jobs.lever.co/company"
              className="h-8 rounded-md border border-line bg-canvas px-2 text-body"
            />
          </label>
          <label className="flex flex-col gap-1 sm:w-56">
            <span className="text-callout text-dim">Company name (optional)</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="From the link if blank"
              className="h-8 rounded-md border border-line bg-canvas px-2 text-body"
            />
          </label>
          <button type="submit" disabled={pending} className="btn btn-primary h-8 shrink-0">
            Watch
          </button>
        </form>
        {notice && (
          <p role="status" className={`px-4 pb-3 text-callout ${notice.tone === "ok" ? "text-ok" : "text-bad"}`}>
            {notice.text}
          </p>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-2">
        <label className="relative flex w-full min-w-0 items-center sm:w-auto sm:max-w-xs sm:flex-1">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 size-4 text-faint" />
          <span className="sr-only">Search boards</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search companies"
            className="h-8 w-full rounded-md border border-line bg-canvas pr-2 pl-8 text-body"
          />
        </label>
        <div role="tablist" aria-label="Show" className="flex max-w-full overflow-x-auto rounded-md bg-raised p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={`shrink-0 rounded px-2.5 py-1 text-callout whitespace-nowrap ${
                filter === f.id ? "bg-panel font-semibold text-ink shadow-sm" : "text-dim hover:text-ink"
              }`}
            >
              {f.label} <span className="tabular-nums text-faint">{counts[f.id]}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="card relative overflow-x-auto">
        {shown.length === 0 ? (
          <p className="px-4 py-6 text-callout text-dim">
            {boards.length === 0
              ? "No boards yet. They're added on the next refresh from your listings' apply links, or you can add one above."
              : "No boards match."}
          </p>
        ) : (
          <table className="w-full min-w-[40rem] text-left text-callout">
            <thead className="border-b border-line-soft text-subhead text-faint">
              <tr>
                <th className="px-4 py-2 font-medium">Company</th>
                <th className="px-3 py-2 font-medium">Last check</th>
                <th className="px-3 py-2 text-right font-medium">Internships</th>
                <th className="px-3 py-2 text-right font-medium">Found</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className={`border-b border-line-soft last:border-0 ${b.muted ? "text-faint" : ""}`}>
                  <td className="px-4 py-2">
                    <div className="font-medium text-ink">{b.companyName}</div>
                    <a
                      href={b.pageUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="inline-flex items-center gap-1 text-subhead text-faint hover:text-accent"
                    >
                      {b.atsLabel} · {b.slug}
                      <ExternalLink aria-hidden className="size-3" />
                      <span className="sr-only">(opens in a new tab)</span>
                    </a>
                    {b.manual && <span className="ml-2 text-subhead text-faint">added by hand</span>}
                  </td>
                  <td className="px-3 py-2">
                    {b.muted ? (
                      <span>Stopped</span>
                    ) : b.lastStatus === null || b.lastCheckedAt === null ? (
                      <span className="text-dim">Not checked yet</span>
                    ) : (
                      <span className={b.lastStatus === "ok" ? "text-dim" : "text-warn"}>
                        {statusText(b.lastStatus)} · {ago(b.lastCheckedAt, nowMs)}
                        {b.paused && <span className="block text-subhead">Paused after {pauseAfter} failed checks</span>}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {b.lastInternCount === null ? (
                      <span className="text-faint">–</span>
                    ) : (
                      <>
                        <span className="text-ink">{b.lastInternCount}</span>
                        <span className="text-faint"> of {b.lastJobCount}</span>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.listingsFound}</td>
                  <td className="px-4 py-2 text-right whitespace-nowrap">
                    {b.paused && !b.muted && (
                      <button
                        type="button"
                        disabled={pending}
                        className="btn mr-2"
                        onClick={() => run(() => retryBoardAction({ id: b.id }))}
                      >
                        Retry
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={pending}
                      className="btn"
                      aria-label={`${b.muted ? "Watch" : "Stop watching"} ${b.companyName}`}
                      onClick={() => run(() => setBoardWatchedAction({ id: b.id, watched: b.muted }))}
                    >
                      {b.muted ? "Watch again" : "Stop watching"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-subhead text-faint">
        Stopping a board stops checking it. Listings it already found stay until you dismiss them. A board that fails{" "}
        {pauseAfter} checks in a row is paused until you retry it.
      </p>
    </div>
  );
}
