"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ListingDetail } from "@/lib/listings/detail";
import { loadDetailAction } from "./actions";
import type { DetailLoadState } from "./DetailPanel";

/** j/k can move several rows a second; only load where the cursor settles. */
const LOAD_DELAY_MS = 120;

/**
 * Loads the detail read model for the open listing, on demand.
 *
 * Details are cached per listing for the session, so walking back and forth
 * with j/k is instant. `invalidate(id)` drops a listing's entry after a write
 * (status, notes…) and, if it is the one on screen, refetches it in the
 * background while the old copy stays visible.
 */
export function useListingDetail(openId: string | null) {
  const cache = useRef(new Map<string, ListingDetail | null>());
  const [state, setState] = useState<{ id: string | null; load: DetailLoadState }>({
    id: null,
    load: { status: "loading" },
  });
  const seq = useRef(0);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!openId) return;
    const id = openId;
    const mine = ++seq.current;
    const cached = cache.current.get(id);

    if (cached !== undefined) {
      setState({
        id,
        load: cached ? { status: "ready", detail: cached, refreshing: false } : { status: "missing" },
      });
      return;
    }

    // Keep showing the stale copy of THIS listing while it refreshes.
    setState((prev) =>
      prev.id === id && prev.load.status === "ready"
        ? { id, load: { ...prev.load, refreshing: true } }
        : { id, load: { status: "loading" } },
    );

    const timer = setTimeout(async () => {
      let res: Awaited<ReturnType<typeof loadDetailAction>>;
      try {
        res = await loadDetailAction({ listingId: id });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (mine !== seq.current) return; // the cursor has moved on
      if (res.ok) {
        cache.current.set(id, res.detail);
        setState({
          id,
          load: res.detail
            ? { status: "ready", detail: res.detail, refreshing: false }
            : { status: "missing" },
        });
      } else {
        setState({ id, load: { status: "error", message: res.message } });
      }
    }, LOAD_DELAY_MS);

    return () => clearTimeout(timer);
  }, [openId, nonce]);

  const invalidate = useCallback(
    (id: string) => {
      cache.current.delete(id);
      if (id === openId) setNonce((n) => n + 1);
    },
    [openId],
  );

  const retry = useCallback(() => {
    if (openId) cache.current.delete(openId);
    setNonce((n) => n + 1);
  }, [openId]);

  const load: DetailLoadState =
    state.id === openId ? state.load : { status: "loading" };
  return { load, invalidate, retry };
}
