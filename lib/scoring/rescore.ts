import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { loadScoringConfig, type ScoringConfig } from "@/lib/scoring/config";
import { scoreListing, SCORING_ENGINE_VERSION, type ScoringInput } from "@/lib/scoring/engine";
import { assessPosting, createAnthropicClient, type LlmClient } from "@/lib/scoring/llm";

/**
 * Persistence + orchestration around the pure scoring engine.
 *
 * Stage 1 runs over every listing whose stored scoringConfigHash differs from
 * the current config hash (so editing config/scoring.json triggers a rescore
 * with no restart and no redeploy). Stage 2 calls the Claude API only for
 * listings that clear the llmMin threshold AND have posting text, and only on
 * a cache miss keyed by (listingId, posting-text hash).
 */

/** The orchestration knobs the engine's config exposes — one place to adapt. */
export interface OrchestrationSettings {
  detailFetchMin: number;
  llmMin: number;
  llmEnabled: boolean;
  /** Passed straight to assessPosting, so config edits reach the API call. */
  llmOptions: {
    model: string;
    maxAdjustment: number;
    maxPostingTextChars: number;
    maxRationaleChars: number;
    maxTokens: number;
  };
}

export function orchestrationSettings(config: ScoringConfig): OrchestrationSettings {
  return {
    detailFetchMin: config.thresholds.detailFetchMin,
    llmMin: config.thresholds.llmMin,
    llmEnabled: config.llm.enabled,
    llmOptions: {
      model: config.llm.model,
      maxAdjustment: config.llm.maxAdjustment,
      maxPostingTextChars: config.llm.maxPostingTextChars,
      maxRationaleChars: config.llm.maxRationaleChars,
      maxTokens: config.llm.maxTokens,
    },
  };
}

export interface RescoreOptions {
  now?: Date;
  log?: (message: string) => void;
  /** Rescore every listing regardless of stored config hash. */
  force?: boolean;
  /** Skip stage 2 entirely (the provisional pass before detail fetching). */
  skipLlm?: boolean;
  /** Injected for tests; defaults to a real Anthropic client when stage 2 runs. */
  llmClient?: LlmClient;
  batchSize?: number;
  /** Hard cap on API calls per run — cost guard. */
  maxLlmCalls?: number;
  /**
   * Recompute global ranks at the end (default true). The provisional pass of
   * a cycle sets this false: ranking half-scored listings would report movement
   * that the final pass immediately undoes.
   */
  updateRanks?: boolean;
}

export interface RescoreSummary {
  configHash: string;
  scored: number;
  disqualified: number;
  /** Rows whose scoring threw; skipped so one bad listing can't abort a run. */
  failed: number;
  /** Listings whose global rank changed in this run. */
  ranked: number;
  llmCacheHits: number;
  llmCalls: number;
  llmFailures: number;
}

/**
 * Rescore anything not scored within this window even when the config is
 * unchanged: `freshness` decays with time and `deadlineUrgency` opens and
 * closes, so a purely hash-gated pass would freeze both at first-score time.
 * Under the daily cron this means one full pure-CPU pass per day.
 */
const DEFAULT_RESCORE_MAX_AGE_HOURS = 20;

export function positiveNumberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  // A typo must never silently remove a spend cap (NaN >= n is always false)
  // nor silently disable a stage (0).
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const LISTING_SELECT = {
  id: true,
  title: true,
  category: true,
  postingText: true,
  postingTextHash: true,
  locations: true,
  countries: true,
  remote: true,
  degrees: true,
  sponsorship: true,
  postedAt: true,
  deadline: true,
  likelyClosed: true,
  terms: true,
  company: { select: { name: true, faangPlus: true, tierOverride: true } },
} as const;

type ListingRow = {
  id: string;
  title: string;
  category: string | null;
  postingText: string | null;
  postingTextHash: string | null;
  locations: string[];
  countries: string[];
  remote: boolean;
  degrees: string[];
  sponsorship: string | null;
  postedAt: Date | null;
  deadline: Date | null;
  likelyClosed: boolean;
  terms: string[];
  company: { name: string; faangPlus: boolean; tierOverride: number | null };
};

function toScoringInput(row: ListingRow): ScoringInput {
  return {
    title: row.title,
    category: row.category,
    postingText: row.postingText,
    locations: row.locations,
    countries: row.countries,
    remote: row.remote,
    degrees: row.degrees,
    sponsorship: row.sponsorship,
    postedAt: row.postedAt,
    deadline: row.deadline,
    likelyClosed: row.likelyClosed,
    terms: row.terms,
    company: row.company,
  };
}

const clampScore = (n: number) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Small transactions, not one big one. Each score write carries a JSON
 * breakdown, and a 200-row transaction ran past Prisma's 5s transaction limit
 * (P2028) — throwing out of the whole pass. Raising the timeout instead would
 * hold row locks open long enough to stall the user's own writes (saving or
 * dismissing a listing mid-rescore), so chunks stay short.
 */
const WRITE_CHUNK = 50;

async function writeScores(
  writes: Array<{ id: string; disqualified: boolean; data: Prisma.ListingUpdateInput }>,
  log: (m: string) => void,
): Promise<{ ok: number; failed: number; disqualified: number }> {
  let ok = 0;
  let failed = 0;
  let disqualified = 0;
  for (let i = 0; i < writes.length; i += WRITE_CHUNK) {
    const chunk = writes.slice(i, i + WRITE_CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((w) => prisma.listing.update({ where: { id: w.id }, data: w.data })),
        { timeout: 20_000 },
      );
      ok += chunk.length;
      disqualified += chunk.filter((w) => w.disqualified).length;
    } catch (err) {
      // Scores are independent per listing, so fall back row by row: one bad
      // row or one slow moment must not cost the other 49. A row that still
      // fails keeps its stale hash and is picked up by the next pass.
      log(`[scoring] stage 1 chunk write failed, retrying row by row: ${String(err).slice(0, 160)}`);
      for (const w of chunk) {
        try {
          await prisma.listing.update({ where: { id: w.id }, data: w.data });
          ok += 1;
          if (w.disqualified) disqualified += 1;
        } catch (rowErr) {
          failed += 1;
          log(`[scoring] stage 1 write failed for ${w.id}: ${String(rowErr).slice(0, 160)}`);
        }
      }
    }
  }
  return { ok, failed, disqualified };
}

/** Stage 1: deterministic scoring for every listing that needs it. */
async function runStageOne(
  config: ScoringConfig,
  configHash: string,
  now: Date,
  batchSize: number,
  force: boolean,
  log: (m: string) => void,
): Promise<{ scored: number; disqualified: number; failed: number }> {
  const staleBefore = new Date(
    now.getTime() -
      positiveNumberFromEnv("RESCORE_MAX_AGE_HOURS", DEFAULT_RESCORE_MAX_AGE_HOURS) *
        60 *
        60 *
        1000,
  );
  const where = force
    ? {}
    : {
        OR: [
          { scoringConfigHash: null },
          { NOT: { scoringConfigHash: configHash } },
          // Time-dependent components (freshness, deadlineUrgency) go stale
          // even when nothing about the listing or the config changed.
          { scoredAt: null },
          { scoredAt: { lt: staleBefore } },
        ],
      };

  let cursor: string | undefined;
  let scored = 0;
  let disqualified = 0;
  let failed = 0;

  for (;;) {
    // An explicit `id > cursor` range, NOT Prisma's `cursor` option: these
    // writes remove rows from `where`, and a cursor row that no longer matches
    // the filter cannot be positioned, which silently skips rows.
    const batch: ListingRow[] = await prisma.listing.findMany({
      where: cursor ? { AND: [where, { id: { gt: cursor } }] } : where,
      select: LISTING_SELECT,
      orderBy: { id: "asc" },
      take: batchSize,
    });
    if (batch.length === 0) break;

    cursor = batch[batch.length - 1].id;

    const writes: Array<{ id: string; disqualified: boolean; data: Prisma.ListingUpdateInput }> = [];
    for (const row of batch) {
      let result;
      try {
        result = scoreListing(toScoringInput(row), config, now);
      } catch (err) {
        // One pathological listing must not abort the whole pass.
        failed += 1;
        log(`[scoring] stage 1 failed for ${row.id}: ${String(err)}`);
        continue;
      }
      writes.push({
        id: row.id,
        disqualified: result.disqualified,
        data: {
          ruleScore: result.ruleScore,
          gateScore: result.gateScore,
          // finalScore is provisional here; stage 2 may adjust it.
          finalScore: result.ruleScore,
          llmAdjustment: null,
          scoreBreakdown: result.breakdown,
          disqualified: result.disqualified,
          disqualifyReasons: result.disqualifyReasons,
          scoredAt: now,
          scoringConfigHash: configHash,
        },
      });
    }

    const written = await writeScores(writes, log);
    scored += written.ok;
    failed += written.failed;
    disqualified += written.disqualified;
    log(`[scoring] stage 1: ${scored} listings scored`);
  }

  return { scored, disqualified, failed };
}

/** Stage 2: cached Claude adjustment for high scorers that have posting text. */
async function runStageTwo(
  settings: OrchestrationSettings,
  now: Date,
  client: LlmClient | undefined,
  maxCalls: number,
  maxCandidates: number,
  log: (m: string) => void,
): Promise<{ llmCacheHits: number; llmCalls: number; llmFailures: number }> {
  let llmCacheHits = 0;
  let llmCalls = 0;
  let llmFailures = 0;

  // postingText (up to 20KB/row) is deliberately NOT selected here: most
  // candidates are cache hits and never need it. It's fetched per cache miss.
  const candidates = await prisma.listing.findMany({
    where: {
      disqualified: false,
      dismissed: false,
      likelyClosed: false,
      ruleScore: { gte: settings.llmMin },
      // Stage 2 never runs without posting text — a title-only call is money
      // spent on no signal.
      postingText: { not: null },
      postingTextHash: { not: null },
    },
    select: {
      id: true,
      title: true,
      postingTextHash: true,
      ruleScore: true,
      llmAdjustment: true,
      company: { select: { name: true } },
    },
    orderBy: { ruleScore: "desc" },
    take: maxCandidates,
  });

  for (const listing of candidates) {
    const textHash = listing.postingTextHash!;
    const cached = await prisma.llmAssessment.findUnique({
      where: { listingId_textHash: { listingId: listing.id, textHash } },
    });

    let adjustment: number;
    if (cached) {
      adjustment = cached.adjustment;
      llmCacheHits += 1;
    } else {
      if (!client || llmCalls >= maxCalls) continue;
      const row = await prisma.listing.findUnique({
        where: { id: listing.id },
        select: { postingText: true },
      });
      if (!row?.postingText) continue;

      let assessment;
      try {
        assessment = await assessPosting(
          {
            company: listing.company.name,
            title: listing.title,
            postingText: row.postingText,
            ruleScore: listing.ruleScore!,
          },
          client,
          settings.llmOptions,
        );
      } catch (err) {
        // A failed assessment leaves the stage-1 score standing.
        llmFailures += 1;
        log(`[scoring] stage 2 failed for ${listing.id}: ${String(err)}`);
        continue;
      }
      // Billed the moment the call returns: counting it after the write would
      // let a failed insert bypass the cap and re-bill the same text forever.
      llmCalls += 1;
      adjustment = assessment.adjustment;

      try {
        // Upsert, not create: a write failure must not discard a paid result,
        // and a concurrent run may have inserted the same (listing, text) pair.
        await prisma.llmAssessment.upsert({
          where: { listingId_textHash: { listingId: listing.id, textHash } },
          create: {
            listingId: listing.id,
            textHash,
            adjustment: assessment.adjustment,
            rationale: assessment.rationale,
            model: assessment.model,
          },
          update: {
            adjustment: assessment.adjustment,
            rationale: assessment.rationale,
            model: assessment.model,
          },
        });
      } catch (err) {
        // The score below is still applied; only the cache entry is lost.
        log(`[scoring] stage 2 cache write failed for ${listing.id}: ${String(err)}`);
      }
    }

    try {
      await prisma.listing.update({
        where: { id: listing.id },
        data: {
          llmAdjustment: adjustment,
          finalScore: clampScore((listing.ruleScore ?? 0) + adjustment),
          // Only a real change moves scoredAt, so it stays meaningful.
          ...(listing.llmAdjustment === adjustment ? {} : { scoredAt: now }),
        },
      });
    } catch (err) {
      log(`[scoring] stage 2 apply failed for ${listing.id}: ${String(err)}`);
    }
  }

  return { llmCacheHits, llmCalls, llmFailures };
}

export async function rescoreListings(opts: RescoreOptions = {}): Promise<RescoreSummary> {
  const now = opts.now ?? new Date();
  const log = opts.log ?? ((m: string) => console.log(m));
  const batchSize = opts.batchSize ?? 200;
  const maxCalls = opts.maxLlmCalls ?? positiveNumberFromEnv("LLM_MAX_CALLS_PER_RUN", 200);
  const maxCandidates = positiveNumberFromEnv("LLM_MAX_CANDIDATES_PER_RUN", 2000);

  // Read + hash the config on every run: editing weights needs no restart.
  // The engine version is folded in so a scoring-logic change also invalidates
  // stored scores — the config hash alone would not notice a code deploy.
  const { config, hash: configHash } = loadScoringConfig();
  const hash = `v${SCORING_ENGINE_VERSION}-${configHash}`;
  const settings = orchestrationSettings(config);
  log(`[scoring] config hash ${hash.slice(0, 15)}`);

  const stageOne = await runStageOne(config, hash, now, batchSize, opts.force ?? false, log);

  let stageTwo = { llmCacheHits: 0, llmCalls: 0, llmFailures: 0 };
  if (!opts.skipLlm && settings.llmEnabled) {
    let client = opts.llmClient;
    if (!client) {
      try {
        client = createAnthropicClient();
      } catch (err) {
        // No API key configured: cached assessments still apply, no new calls.
        log(`[scoring] stage 2 client unavailable (${String(err)}); using cache only`);
      }
    }
    stageTwo = await runStageTwo(settings, now, client, maxCalls, maxCandidates, log);
  }

  // Ranks are assigned last, once scores have settled. The provisional pass in
  // a cycle passes updateRanks:false so half-scored listings never publish a
  // rank — otherwise every cycle would report spurious movement.
  let ranked = 0;
  if (opts.updateRanks ?? true) {
    ranked = await recomputeRanks(now);
    log(`[scoring] ranks: ${ranked} listing(s) moved`);
  }

  return {
    configHash: hash,
    scored: stageOne.scored,
    disqualified: stageOne.disqualified,
    failed: stageOne.failed,
    ranked,
    ...stageTwo,
  };
}

/**
 * Schema-qualified table name for raw SQL.
 *
 * Prisma's driver adapter applies the `?schema=` parameter to the queries IT
 * generates, but raw SQL is sent verbatim and resolves through the connection's
 * `search_path` — which `prisma dev`'s proxy leaks between connections. An
 * unqualified `"Listing"` therefore silently hit the test schema. Never write
 * an unqualified table name in raw SQL here.
 */
export function qualifiedListingTable(): string {
  let schema = "public";
  try {
    schema = new URL(process.env.DATABASE_URL ?? "").searchParams.get("schema") ?? "public";
  } catch {
    /* falls back to public */
  }
  // The value reaches SQL as an identifier, which cannot be parameterized.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
    throw new Error(`refusing unsafe schema name in DATABASE_URL: ${schema}`);
  }
  return `"${schema}"."Listing"`;
}

/**
 * Assigns each non-disqualified listing its global position by score, so every
 * reader agrees on rank instead of deriving it from whatever order they loaded.
 *
 * Both statements only touch rows whose rank actually changes (`IS DISTINCT
 * FROM`), which is what keeps `previousRank`/`rankChangedAt` meaningful: a
 * listing that holds its position across runs keeps the history of its last
 * real move. Returns how many listings moved.
 */
export async function recomputeRanks(now: Date): Promise<number> {
  const table = qualifiedListingTable();

  // Ordering mirrors the table's default sort so rank 1 is the top row.
  const moved = await prisma.$executeRawUnsafe(
    `WITH ranked AS (
       SELECT id, row_number() OVER (
         ORDER BY "finalScore" DESC NULLS LAST, "firstSeen" DESC, id ASC
       ) AS rn
       FROM ${table}
       WHERE NOT disqualified
     )
     UPDATE ${table} l
     SET "previousRank" = l."rank", "rank" = r.rn, "rankChangedAt" = $1
     FROM ranked r
     WHERE l.id = r.id AND l."rank" IS DISTINCT FROM r.rn`,
    now,
  );

  // A disqualified listing has no meaningful position, but keeps where it was
  // so the detail panel can say what it fell from.
  const cleared = await prisma.$executeRawUnsafe(
    `UPDATE ${table}
     SET "previousRank" = "rank", "rank" = NULL, "rankChangedAt" = $1
     WHERE disqualified AND "rank" IS NOT NULL`,
    now,
  );

  return moved + cleared;
}
