import { z } from "zod";

/**
 * The app's side of the worker's internal endpoints: POST /refresh starts a
 * full cycle, GET /healthz says whether one is running and how the last one
 * went. The worker is reachable only on the compose network (never through
 * Traefik), so this runs on the server, from a Server Action.
 *
 * The worker is trusted code, but its answer still crosses a process
 * boundary, so it is parsed rather than cast.
 */

export const DEFAULT_WORKER_URL = "http://tracker-worker:8081";

export function workerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.WORKER_URL?.trim() || DEFAULT_WORKER_URL).replace(/\/+$/, "");
}

const healthSchema = z.object({
  running: z.boolean(),
  lastRun: z
    .object({
      at: z.string(),
      error: z.string().optional(),
      summary: z
        .object({
          ingestion: z.object({
            sources: z.array(z.object({ source: z.string(), ok: z.boolean(), itemsNew: z.number() })),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

export interface RefreshStatus {
  running: boolean;
  /** When the last cycle finished, ISO; null if none since the worker started. */
  lastRunAt: string | null;
  /** Listings the last cycle added. */
  newListings: number;
  /** Sources that failed in the last cycle. */
  failedSources: string[];
  /** The last cycle threw. */
  error: string | null;
}

export function parseHealth(body: unknown): RefreshStatus {
  const h = healthSchema.parse(body);
  const sources = h.lastRun?.summary?.ingestion.sources ?? [];
  return {
    running: h.running,
    lastRunAt: h.lastRun?.at ?? null,
    newListings: sources.reduce((n, s) => n + s.itemsNew, 0),
    failedSources: sources.filter((s) => !s.ok).map((s) => s.source),
    error: h.lastRun?.error ?? null,
  };
}

type Fetch = typeof globalThis.fetch;

/** Starts a cycle. "already" when one is running (the worker answers 409). */
export async function startRefresh(fetchImpl: Fetch = fetch): Promise<"started" | "already"> {
  const res = await fetchImpl(`${workerUrl()}/refresh`, { method: "POST", signal: AbortSignal.timeout(5000) });
  if (res.status === 409) return "already";
  if (!res.ok) throw new Error(`worker answered ${res.status}`);
  return "started";
}

export async function refreshStatus(fetchImpl: Fetch = fetch): Promise<RefreshStatus> {
  const res = await fetchImpl(`${workerUrl()}/healthz`, { signal: AbortSignal.timeout(5000), cache: "no-store" });
  if (!res.ok) throw new Error(`worker answered ${res.status}`);
  return parseHealth(await res.json());
}
