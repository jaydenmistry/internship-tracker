"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { celebrateRefresh } from "@/components/celebrate";
import { refreshStatusAction, startRefreshAction } from "./actions";
import type { Toast } from "./row-actions";

const POLL_MS = 4000;

/**
 * "Refresh now": asks the worker for a full cycle (ingest → score → posting
 * fetch → rescore), spins while it runs, then reloads the table and says how
 * many listings arrived. A cycle can take minutes; leaving the page and
 * coming back picks the spinner up again, because the worker is the one
 * that knows.
 */
export default function RefreshButton({ notify }: { notify: (toast: Toast) => void }) {
  const router = useRouter();
  const buttonRef = useRef<HTMLButtonElement>(null);
  /** The last cycle's finish time when this run started; a different one means done. */
  const [watching, setWatching] = useState<{ before: string | null } | null>(null);
  const [starting, setStarting] = useState(false);

  // A cycle already running (cron, or started before a reload)? Show it.
  useEffect(() => {
    let cancelled = false;
    void refreshStatusAction()
      .then((res) => {
        if (!cancelled && res.ok && res.status.running) setWatching({ before: res.status.lastRunAt });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!watching) return;
    let cancelled = false;
    const id = window.setInterval(async () => {
      let res;
      try {
        res = await refreshStatusAction();
      } catch {
        return; // a dropped poll; the next one tries again
      }
      if (cancelled) return;
      if (!res.ok) {
        setWatching(null);
        notify({ kind: "error", message: res.message });
        return;
      }
      const s = res.status;
      if (s.running || s.lastRunAt === watching.before) return;
      setWatching(null);
      router.refresh();
      if (s.error) {
        notify({ kind: "error", message: `Refresh failed: ${s.error}` });
        return;
      }
      const failed = s.failedSources.length ? ` (${s.failedSources.join(", ")} failed)` : "";
      const added = s.newListings;
      notify({
        kind: added > 0 ? "celebrate" : "ok",
        message:
          added > 0
            ? `✨ ${added.toLocaleString("en-US")} new listing${added === 1 ? "" : "s"}${failed}`
            : `Up to date: no new listings${failed}`,
      });
      celebrateRefresh(buttonRef.current, added);
    }, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [watching, notify, router]);

  const busy = watching !== null || starting;
  const label = busy ? "Refreshing listings…" : "Refresh now: fetch new listings and rescore";

  async function start() {
    if (busy) return;
    setStarting(true);
    try {
      // Read the last finish first, so a cycle that ends between polls still counts as done.
      const before = await refreshStatusAction();
      const res = await startRefreshAction();
      if (!res.ok) notify({ kind: "error", message: res.message });
      else setWatching({ before: before.ok ? before.status.lastRunAt : null });
    } catch (err) {
      notify({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      setStarting(false);
    }
  }

  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={start}
      disabled={busy}
      aria-busy={busy || undefined}
      title={label}
      aria-label={label}
      className="flex h-7 items-center gap-1.5 rounded-full border border-line px-2.5 text-callout text-dim hover:bg-raised hover:text-ink disabled:cursor-progress disabled:hover:bg-transparent"
    >
      <RefreshCw aria-hidden size={13} className={busy ? "animate-spin" : undefined} />
      <span className="hidden sm:inline">{busy ? "Refreshing…" : "Refresh"}</span>
    </button>
  );
}
