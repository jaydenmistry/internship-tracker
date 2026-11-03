import { describe, expect, it, vi } from "vitest";
import { DEFAULT_WORKER_URL, parseHealth, refreshStatus, startRefresh, workerUrl } from "@/lib/worker-client";

describe("worker client", () => {
  it("defaults to the compose service, trimming a trailing slash from an override", () => {
    expect(workerUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_WORKER_URL);
    expect(workerUrl({ WORKER_URL: "http://w:9000/" } as unknown as NodeJS.ProcessEnv)).toBe("http://w:9000");
  });

  it("sums new listings and names failed sources from /healthz", () => {
    const status = parseHealth({
      ok: true,
      running: false,
      lastAlerts: {},
      lastRun: {
        at: "2026-11-02T12:00:00.000Z",
        summary: {
          ingestion: {
            sources: [
              { source: "simplify", ok: true, itemsNew: 9, itemsSeen: 100 },
              { source: "intern-list", ok: false, itemsNew: 3, error: "boom" },
            ],
          },
        },
      },
    });
    expect(status).toEqual({
      running: false,
      lastRunAt: "2026-11-02T12:00:00.000Z",
      newListings: 12,
      failedSources: ["intern-list"],
      error: null,
    });
  });

  it("handles a worker that hasn't run yet, or whose last run threw", () => {
    expect(parseHealth({ running: true, lastRun: null })).toMatchObject({ running: true, lastRunAt: null, newListings: 0 });
    expect(parseHealth({ running: false, lastRun: { at: "x", summary: null, error: "Error: db" } }).error).toBe("Error: db");
    expect(() => parseHealth({ nope: true })).toThrow();
  });

  it("treats 409 as already running", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 409 }));
    await expect(startRefresh(fetchImpl as unknown as typeof fetch)).resolves.toBe("already");
    const ok = vi.fn(async () => new Response("{}", { status: 202 }));
    await expect(startRefresh(ok as unknown as typeof fetch)).resolves.toBe("started");
    const bad = vi.fn(async () => new Response("{}", { status: 500 }));
    await expect(refreshStatus(bad as unknown as typeof fetch)).rejects.toThrow(/500/);
  });
});
