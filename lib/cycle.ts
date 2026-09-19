import {
  runIngestion,
  runDetailFetch,
  type RunSummary,
  type DetailCandidate,
} from "@/lib/ingestion/pipeline";
import type { SourceAdapter } from "@/lib/ingestion/adapters/types";
import type { LlmClient } from "@/lib/scoring/llm";
import { rescoreListings, orchestrationSettings, type RescoreSummary } from "@/lib/scoring/rescore";
import { loadScoringConfig } from "@/lib/scoring/config";

/**
 * One full refresh: ingest → provisional score → posting-detail fetch → final
 * score (+ cached Claude pass).
 *
 * The ordering matters. Most sources ship no description text, so the detail
 * fetch is what makes tech-fit scoring meaningful — but fetching every posting
 * page would be thousands of requests, so a cheap provisional score (title,
 * category, company, location, freshness) picks which pages are worth
 * fetching. Newly fetched text clears the listing's stored config hash, so the
 * final pass rescores exactly those listings, and only then does stage 2 spend
 * API calls.
 */
export interface CycleOptions {
  now?: Date;
  log?: (message: string) => void;
  fetchImpl?: typeof globalThis.fetch;
  /** Skip the Claude pass (stage 1 + detail fetch only). */
  skipLlm?: boolean;
  /** Skip the posting-detail fetch (offline runs). */
  skipDetail?: boolean;
  /** Replace the adapter registry (integration tests use fake sources). */
  adapterOverride?: SourceAdapter[];
  /** Injected for tests; defaults to a real Anthropic client when stage 2 runs. */
  llmClient?: LlmClient;
}

export interface CycleSummary {
  ingestion: RunSummary;
  provisional: RescoreSummary;
  detail: { fetched: number; errors: number };
  final: RescoreSummary;
}

export async function runFullCycle(opts: CycleOptions = {}): Promise<CycleSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m: string) => console.log(m));

  const ingestion = await runIngestion({
    now,
    log,
    fetchImpl: opts.fetchImpl,
    skipDetail: true,
    adapterOverride: opts.adapterOverride,
  });

  // Provisional: deterministic only, so the detail gate has scores to read.
  const provisional = await rescoreListings({ now, log, skipLlm: true });

  let detail = { fetched: 0, errors: 0 };
  if (!opts.skipDetail) {
    const { config } = loadScoringConfig();
    const { detailFetchMin } = orchestrationSettings(config);
    // Gate on gateScore (techFit excluded), NOT ruleScore: gating on a score
    // that counts missing posting text as zero is what starved this stage.
    const selector = (l: DetailCandidate) =>
      !l.dismissed &&
      !l.likelyClosed &&
      !l.disqualified &&
      (l.gateScore === null || l.gateScore >= detailFetchMin);
    detail = await runDetailFetch({
      now,
      log,
      fetchImpl: opts.fetchImpl,
      selector,
      minGateScore: detailFetchMin,
    });
  }

  // Final: rescores whatever the detail fetch invalidated, then stage 2.
  const final = await rescoreListings({
    now,
    log,
    skipLlm: opts.skipLlm,
    llmClient: opts.llmClient,
  });

  log(
    `[cycle] ingest ${ingestion.sources.map((s) => `${s.source}:${s.itemsNew}new`).join(" ")} | ` +
      `detail ${detail.fetched} fetched | scored ${provisional.scored}+${final.scored} | ` +
      `llm ${final.llmCalls} calls, ${final.llmCacheHits} cached`,
  );

  return { ingestion, provisional, detail, final };
}
