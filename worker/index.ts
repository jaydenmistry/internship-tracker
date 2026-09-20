import "dotenv/config";
import { createServer } from "node:http";
import cron from "node-cron";
import { prisma } from "@/lib/db";
import { runFullCycle, type CycleSummary } from "@/lib/cycle";
import { sendAlerts, summarize } from "@/lib/alerts/send";
import type { AlertKind } from "@/lib/alerts/types";

const INGEST_CRON = process.env.INGEST_CRON ?? "0 6 * * *";
const DIGEST_CRON = process.env.DIGEST_CRON ?? "0 7 * * *";
const CLOSING_SOON_CRON = process.env.CLOSING_SOON_CRON ?? "0 8 * * *";
const WORKER_PORT = Number(process.env.WORKER_PORT ?? 8081);
const ALERT_TIMEZONE = process.env.ALERT_TIMEZONE?.trim() || undefined;

let running = false;
let lastRun: { at: string; summary: CycleSummary | null; error?: string } | null = null;
let lastAlerts: Record<string, { at: string; summary: string }> = {};

/**
 * Alerts are best-effort: a dead SMTP host or a revoked webhook must never
 * abort a cycle or take the worker process down. `sendAlerts` already collects
 * per-channel failures instead of throwing; this catches the rest (a database
 * hiccup while reading settings, say) and logs it.
 */
async function alert(kind: AlertKind, trigger: string): Promise<void> {
  try {
    const result = await sendAlerts(kind, { timeZone: ALERT_TIMEZONE });
    lastAlerts = { ...lastAlerts, [kind]: { at: new Date().toISOString(), summary: summarize(result) } };
    for (const failure of result.failures) {
      console.error(`[worker] alert ${kind} ${failure.channel} failed: ${failure.error}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    lastAlerts = { ...lastAlerts, [kind]: { at: new Date().toISOString(), summary: `failed: ${message}` } };
    console.error(`[worker] alert ${kind} (${trigger}) failed:`, err);
  }
}

/**
 * node-cron throws on a malformed pattern, which at module scope would kill the
 * container on boot over a typo in an env var. A bad schedule disables that one
 * job and says so instead.
 */
function schedule(name: string, expression: string, task: () => void): void {
  if (!cron.validate(expression)) {
    console.error(`[worker] ${name} schedule "${expression}" is not a valid cron expression — disabled`);
    return;
  }
  cron.schedule(expression, task);
  console.log(`[worker] ${name} scheduled "${expression}"`);
}

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
    // Immediate alerts ride the tail of the cycle: the listings were just
    // scored, so this is the first moment a new high scorer exists. Awaited so
    // `running` still covers it, but it can never fail the cycle.
    await alert("HIGH_SCORE", trigger);
    return summary;
  } catch (err) {
    lastRun = { at: new Date().toISOString(), summary: null, error: String(err) };
    throw err;
  } finally {
    running = false;
  }
}

schedule("ingest", INGEST_CRON, () => {
  ingest("cron").catch((err) => console.error("[worker] scheduled cycle failed:", err));
});

schedule("daily digest", DIGEST_CRON, () => void alert("DAILY_DIGEST", "cron"));
schedule("closing soon", CLOSING_SOON_CRON, () => void alert("CLOSING_SOON", "cron"));

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
    return respond(200, { ok: true, running, lastRun, lastAlerts });
  }

  return respond(404, { ok: false, error: "not found" });
});

server.listen(WORKER_PORT, () => {
  console.log(`[worker] listening on :${WORKER_PORT}`);
});

async function shutdown(signal: string) {
  console.log(`[worker] ${signal} received, shutting down`);
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
