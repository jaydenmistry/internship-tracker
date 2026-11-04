import type { DetailContext } from "@/lib/ingestion/detail/index";
import { RobotsDeniedError, UnsupportedUrlError, politeFetch } from "@/lib/ingestion/detail/net";
import {
  BOARDS_SOURCE_ID,
  boardKey,
  feedUrl,
  normalizeBoardRecord,
  readFeed,
  type BoardRecord,
} from "@/lib/ingestion/boards/feeds";
import {
  boardsLeftAsIs,
  discoverBoards,
  isDefinitiveStatus,
  loadBoardsToCheck,
  recordBoardChecks,
  type BoardCheck,
  type WatchedBoard,
} from "@/lib/ingestion/boards/store";
import type { AdapterResult, FetchContext, NormalizedListing, SourceAdapter } from "./types";

/**
 * Company job boards: every watched Greenhouse, Lever and Ashby board, read
 * through its public feed, keeping the tech internships. A role shows up here
 * as soon as the company posts it, with its full description, rather than
 * when a curated list gets to it.
 *
 * The watchlist grows by itself (lib/ingestion/boards/store.ts discovers a
 * board from any apply link pointing into one) and is managed on /boards.
 *
 * One board failing never fails the run: the others still count, and the
 * failed board's postings are reported `unverified` so the pipeline keeps
 * them alive instead of marking them likely closed. Only a run where every
 * board failed — the network, not the boards — fails as a whole.
 *
 * Etiquette: politeFetch (robots.txt, ≥1s between requests to one host,
 * timeouts). The three systems are different hosts, so they run side by
 * side, each one board at a time.
 */

export interface JobBoardsDeps {
  discover(): Promise<number>;
  loadBoards(): Promise<WatchedBoard[]>;
  leftAsIs(): Promise<string[]>;
  /** `countFailures: false` records the outcome without moving any board toward a pause. */
  record(checks: BoardCheck[], now: Date, opts: { countFailures: boolean }): Promise<void>;
  /** Injected for tests; the per-host rate limit awaits it. */
  sleep?(ms: number): Promise<void>;
}

interface BoardOutcome {
  board: WatchedBoard;
  check: BoardCheck;
  kept: BoardRecord[];
}

async function checkBoard(board: WatchedBoard, ctx: DetailContext): Promise<BoardOutcome> {
  const fail = (status: string): BoardOutcome => ({ board, check: { key: board.key, status }, kept: [] });
  let res: Response;
  try {
    res = await politeFetch(feedUrl(board), ctx);
  } catch (err) {
    if (err instanceof RobotsDeniedError) return fail("robots_denied");
    if (err instanceof UnsupportedUrlError) return fail("unsupported_url");
    ctx.log(`${board.key}: ${err instanceof Error ? err.message : String(err)}`);
    return fail("fetch_failed");
  }
  if (!res.ok) {
    await res.text().catch(() => "");
    return fail(`http_${res.status}`);
  }
  try {
    // Lever sometimes answers an API call with an HTML page; that's a
    // failed check, not an empty board.
    if (!/json/i.test(res.headers.get("content-type") ?? "")) {
      await res.text().catch(() => "");
      return fail("parse_failed");
    }
    const feed = readFeed(board, board.companyName, await res.json());
    return { board, check: { key: board.key, status: "ok", total: feed.total, kept: feed.kept.length }, kept: feed.kept };
  } catch (err) {
    ctx.log(`${board.key}: unreadable feed: ${err instanceof Error ? err.message : String(err)}`);
    return fail("parse_failed");
  }
}

export function createJobBoardsAdapter(deps: JobBoardsDeps): SourceAdapter {
  return {
    id: BOARDS_SOURCE_ID,
    displayName: "Company job boards",
    normalizeRecord: normalizeBoardRecord,
    async fetch(fctx: FetchContext): Promise<AdapterResult> {
      const added = await deps.discover();
      if (added > 0) fctx.log(`watching ${added} newly discovered board(s)`);
      const boards = await deps.loadBoards();

      const ctx: DetailContext = {
        fetch: fctx.fetch,
        userAgent: fctx.userAgent,
        now: fctx.now,
        log: fctx.log,
        sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
        robotsCache: new Map(),
        urlCache: new Map(),
      };
      const byAts = Map.groupBy(boards, (b) => b.ats);
      const outcomes = (
        await Promise.all(
          [...byAts.values()].map(async (group) => {
            const out: BoardOutcome[] = [];
            for (const board of group) out.push(await checkBoard(board, ctx));
            return out;
          }),
        )
      ).flat();
      // No board gave a definite answer (a feed, or a 404 saying the board is
      // gone): that's our network, not the boards. Fail the run, which holds
      // back the likely-closed pass, and don't count it toward any board's
      // pause, or one long outage would quietly pause the whole watchlist.
      const failed = outcomes.filter((o) => o.check.status !== "ok");
      const outage = outcomes.length > 0 && !outcomes.some((o) => isDefinitiveStatus(o.check.status));
      await deps.record(
        outcomes.map((o) => o.check),
        fctx.now,
        { countFailures: !outage },
      );
      if (outage) {
        throw new Error(`all ${outcomes.length} board(s) failed (first: ${failed[0].board.key} ${failed[0].check.status})`);
      }

      const records = outcomes.flatMap((o) => o.kept);
      const rawPayload = JSON.stringify({
        boards: outcomes.map((o) => ({ ...o.check })),
        records,
      });
      await fctx.saveRaw?.(rawPayload);

      const listings: NormalizedListing[] = [];
      // A posting the board still lists but we couldn't read stays as it was.
      const unreadable: string[] = [];
      for (const record of records) {
        const result = normalizeBoardRecord(record);
        if (result.ok) {
          listings.push(result.listing);
          continue;
        }
        fctx.log(`${record.ats}:${record.slug}: skipped a posting: ${result.error}`);
        const id = (record.job as { id?: unknown } | null)?.id;
        if (typeof id === "string" || typeof id === "number") {
          unreadable.push(`${boardKey(record)}:${String(id).toLowerCase()}`);
        }
      }
      const unverified = [
        // Whole boards end in ":" so "ramp" never covers "ramp-2"; a single
        // posting is its exact sourceUid.
        ...[
          ...failed.filter((o) => !isDefinitiveStatus(o.check.status)).map((o) => o.board.key),
          ...(await deps.leftAsIs()),
        ].map((key) => `${key}:`),
        ...unreadable,
      ];

      const issues = failed.length > 0 ? `, ${failed.length} failed` : "";
      fctx.log(`checked ${outcomes.length} board(s)${issues}: ${listings.length} internship(s)`);
      return { listings, rawPayload, unverified };
    },
  };
}

export const jobBoardsAdapter = createJobBoardsAdapter({
  discover: discoverBoards,
  loadBoards: loadBoardsToCheck,
  leftAsIs: boardsLeftAsIs,
  record: recordBoardChecks,
});
