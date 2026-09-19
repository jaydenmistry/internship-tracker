import "dotenv/config";
import { createServer } from "node:http";
import cron from "node-cron";
import { prisma } from "@/lib/db";
import { runFullCycle, type CycleSummary } from "@/lib/cycle";

const INGEST_CRON = process.env.INGEST_CRON ?? "0 6 * * *";
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8081);

let running = false;
let lastRun: { at: string; summary: CycleSummary | null; error?: string } | null = null;

async function ingest(trigger: string): Promise<CycleSummary> {
  if (running) throw new Error("ingestion already running");
  running = true;
  console.log(`[worker] cycle started (${trigger})`);
  try {
    const summary = await runFullCycle();
    lastRun = { at: new Date().toISOString(), summary };
    console.log(
      `[worker] cycle finished: ${summary.ingestion.sources
        .map((s) => `${s.source}:${s.ok ? `${s.itemsNew} new/${s.itemsUpdated} upd` : "FAILED"}`)
        .join(", ")}, ${summary.ingestion.likelyClosed} likely-closed, ` +
        `${summary.detail.fetched} detail fetches, ${summary.final.llmCalls} llm calls`,
    );
    return summary;
  } catch (err) {
    lastRun = { at: new Date().toISOString(), summary: null, error: String(err) };
    throw err;
  } finally {
    running = false;
  }
}

cron.schedule(INGEST_CRON, () => {
  ingest("cron").catch((err) => console.error("[worker] scheduled cycle failed:", err));
});

// Internal-only HTTP endpoint (compose network, never exposed via Traefik):
// the app's "refresh now" button POSTs here.
const server = createServer((req, res) => {
  const respond = (code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method === "POST" && req.url === "/refresh") {
    if (running) return respond(409, { ok: false, error: "already running" });
    // Fire and forget; the caller polls /healthz or the IngestRun table.
    ingest("manual").catch((err) => console.error("[worker] manual cycle failed:", err));
    return respond(202, { ok: true, started: true });
  }

  if (req.method === "GET" && req.url === "/healthz") {
    return respond(200, { ok: true, running, lastRun });
  }

  return respond(404, { ok: false, error: "not found" });
});

server.listen(WORKER_PORT, () => {
  console.log(`[worker] listening on :${WORKER_PORT}, ingest cron "${INGEST_CRON}"`);
});

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
