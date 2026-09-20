import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { prisma } from "@/lib/db";
import { adapters } from "@/lib/ingestion/adapters";
import type {
  FetchContext,
  NormalizedListing,
  SourceAdapter,
} from "@/lib/ingestion/adapters/types";
import {
  buildDedupKey,
  canonicalizeUrl,
  deriveCountries,
  extractRequisitionId,
  locationBucket,
  normalizeCompany,
  normalizeTitle,
} from "@/lib/ingestion/normalize";
import { decideMerge, type MergeCandidate } from "@/lib/ingestion/dedupe";
import { fetchDetail, type DetailContext, type DetailResult } from "@/lib/ingestion/detail";
import type { Listing } from "@/generated/prisma/client";

const DEFAULT_USER_AGENT = () =>
  `internship-tracker/0.1 (self-hosted personal tracker; contact: ${
    process.env.USER_AGENT_CONTACT ?? "unset"
  })`;

export interface PipelineOptions {
  now?: Date;
  fetchImpl?: typeof globalThis.fetch;
  log?: (message: string) => void;
  /** Restrict to specific adapter ids (default: all registered). */
  sources?: string[];
  /** Replace the registry entirely (integration tests use fake adapters). */
  adapterOverride?: SourceAdapter[];
  /** Skip the stage-3 posting-detail fetch (used by tests / partial runs). */
  skipDetail?: boolean;
  /**
   * Which listings deserve a stage-3 detail fetch. Phase 2 wires the scoring
   * threshold in here; the default targets current-term software listings.
   */
  detailSelector?: (listing: DetailCandidate) => boolean;
}

/** Narrow field set handed to the detail-stage selector (perf: no postingText). */
const DETAIL_CANDIDATE_SELECT = {
  id: true,
  url: true,
  terms: true,
  category: true,
  dismissed: true,
  likelyClosed: true,
  saved: true,
  finalScore: true,
  ruleScore: true,
  gateScore: true,
  disqualified: true,
  detailFetchedAt: true,
  detailFetchStatus: true,
  firstSeen: true,
} as const;

export type DetailCandidate = Pick<Listing, keyof typeof DETAIL_CANDIDATE_SELECT>;

export interface SourceRunSummary {
  source: string;
  ok: boolean;
  error?: string;
  itemsSeen: number;
  itemsNew: number;
  itemsUpdated: number;
  /** Per-item ingest failures (item skipped, run continued). */
  itemsFailed: number;
}

export interface RunSummary {
  startedAt: Date;
  finishedAt: Date;
  sources: SourceRunSummary[];
  likelyClosed: number;
  detailFetched: number;
  detailErrors: number;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// intern-list terms are often unmappable (empty), so an empty terms array
// passes the term filter rather than being excluded.
const defaultDetailSelector = (listing: DetailCandidate): boolean =>
  !listing.dismissed &&
  !listing.likelyClosed &&
  (listing.terms.length === 0 || listing.terms.includes("Summer 2027")) &&
  (listing.category === null || /software|engineering|swe/i.test(listing.category));

/** Exported for the merge-split path, which resolves the same company row. */
export async function upsertCompany(name: string, faangPlus: boolean) {
  const normalizedName = normalizeCompany(name);
  const company = await prisma.company.upsert({
    where: { normalizedName },
    create: { name, normalizedName, faangPlus },
    // faangPlus is only ever raised, never lowered, by source data.
    update: faangPlus ? { faangPlus: true } : {},
  });
  return company;
}

/**
 * The field mapping from a NormalizedListing to a NEW Listing row — every
 * derived field (normalizedTitle, dedupKey, countries, canonical url,
 * requisitionId, posting-text hash) computed by the same helpers the dedup
 * pass uses.
 *
 * Exported because `splitMerge` (lib/ingestion/split.ts) rebuilds a listing
 * that was merged away and MUST produce the row the pipeline would have
 * created — in particular the dedupKey and normalizedTitle, or the next
 * ingestion run would simply merge it back. `sources` is the caller's
 * business: the run path creates a source row, the split path moves one.
 */
export function buildListingCreateData(
  item: NormalizedListing,
  companyId: string,
  now: Date,
) {
  return {
    companyId,
    title: item.title,
    normalizedTitle: normalizeTitle(item.title),
    dedupKey: buildDedupKey(item.company, item.title, item.locations, item.remote),
    locations: item.locations,
    countries: deriveCountries(item.locations, item.remote),
    remote: item.remote,
    url: canonicalizeUrl(item.url),
    requisitionId: extractRequisitionId(item.url),
    category: item.category,
    terms: item.terms,
    sponsorship: item.sponsorship,
    salary: item.salary,
    degrees: item.degrees,
    postingText: item.postingText,
    postingTextHash: item.postingText ? sha256(item.postingText) : null,
    postedAt: item.postedAt,
    deadline: item.deadline,
    firstSeen: now,
    lastSeen: now,
    likelyClosed: false,
  };
}

/** Ingest one normalized listing: update its per-source row, or dedup + create. */
async function ingestListing(
  item: NormalizedListing,
  now: Date,
  log: (m: string) => void,
): Promise<"new" | "updated"> {
  const company = await upsertCompany(item.company, item.companyFaangPlus);
  const normalizedTitle = normalizeTitle(item.title);
  const bucket = locationBucket(item.locations, item.remote);
  const dedupKey = buildDedupKey(item.company, item.title, item.locations, item.remote);
  const canonicalUrl = canonicalizeUrl(item.url);
  const requisitionId = extractRequisitionId(item.url);
  // ListingSource.raw is a required Json column; plain null is rejected by
  // Prisma, so an adapter omitting raw degrades to an empty object.
  const raw = JSON.parse(JSON.stringify(item.raw ?? {}));

  const existingSource = await prisma.listingSource.findUnique({
    where: { source_sourceUid: { source: item.source, sourceUid: item.sourceUid } },
  });

  if (existingSource) {
    // Anything that changes a scoring input clears scoringConfigHash so the
    // next scoring pass picks the row up — see "score self-invalidation".
    const current = await prisma.listing.findUnique({
      where: { id: existingSource.listingId },
      select: { postingText: true, likelyClosed: true, deadline: true },
    });
    const reopened = item.active && current?.likelyClosed === true;
    const deadlineChanged =
      item.deadline !== undefined &&
      item.deadline.getTime() !== (current?.deadline?.getTime() ?? NaN);

    await prisma.$transaction([
      prisma.listingSource.update({
        where: { id: existingSource.id },
        data: { lastSeen: now, active: item.active, url: item.url, raw },
      }),
      prisma.listing.update({
        where: { id: existingSource.listingId },
        data: {
          lastSeen: now,
          ...(item.active ? { likelyClosed: false } : {}),
          ...(item.salary ? { salary: item.salary } : {}),
          ...(item.deadline ? { deadline: item.deadline } : {}),
          ...(item.sponsorship ? { sponsorship: item.sponsorship } : {}),
          ...(reopened || deadlineChanged ? { scoringConfigHash: null } : {}),
        },
      }),
    ]);
    // Keep the richer posting text without clobbering stage-3 fetched text.
    if (item.postingText) {
      if (!current?.postingText || current.postingText.length < item.postingText.length) {
        await prisma.listing.update({
          where: { id: existingSource.listingId },
          data: {
            postingText: item.postingText,
            postingTextHash: sha256(item.postingText),
            scoringConfigHash: null,
          },
        });
      }
    }
    return "updated";
  }

  // New per-source record: dedup against this company's existing listings in
  // the same location bucket before creating a canonical row.
  const companyListings = await prisma.listing.findMany({
    where: { companyId: company.id },
    select: {
      id: true,
      url: true,
      requisitionId: true,
      dedupKey: true,
      normalizedTitle: true,
      locations: true,
      remote: true,
      firstSeen: true,
      postingText: true,
      // Read by the merge path to tell a reopening from a routine re-merge.
      likelyClosed: true,
    },
  });
  const candidates: MergeCandidate[] = companyListings
    .filter((l) => locationBucket(l.locations, l.remote) === bucket)
    .map((l) => ({
      id: l.id,
      url: canonicalizeUrl(l.url),
      requisitionId: l.requisitionId,
      dedupKey: l.dedupKey,
      normalizedTitle: l.normalizedTitle,
    }));

  // A requisition id proves identity even across location buckets (sources
  // spell locations differently), so check it company-wide first.
  const reqMatch = requisitionId
    ? companyListings.find((l) => l.requisitionId === requisitionId)
    : undefined;

  const decision = reqMatch
    ? ({
        action: "merge",
        targetId: reqMatch.id,
        reason: `req id match (company-wide): ${requisitionId}`,
      } as const)
    : decideMerge({ url: canonicalUrl, requisitionId, dedupKey, normalizedTitle }, candidates);

  const sourceRow = {
    source: item.source,
    sourceUid: item.sourceUid,
    url: item.url,
    active: item.active,
    firstSeen: now,
    lastSeen: now,
    raw,
  };

  if (decision.action === "merge") {
    const target = companyListings.find((l) => l.id === decision.targetId);
    const mergedFromEntry = {
      source: item.source,
      sourceUid: item.sourceUid,
      url: item.url,
      reason: decision.reason,
      mergedAt: now.toISOString(),
    };
    // Same self-invalidation rule the update path above follows. A merge that
    // brings in the first real description, or that reopens a listing marked
    // closed, has changed a scoring input: without clearing the hash the
    // listing stays scored on its title alone until something unrelated
    // happens to invalidate it — and posting text is exactly what stage 2 is
    // gated on, so the merge that earns a listing an LLM pass would not
    // trigger one.
    const adoptsPostingText = Boolean(
      item.postingText &&
        (!target?.postingText || target.postingText.length < item.postingText.length),
    );
    const reopened = item.active && target?.likelyClosed === true;

    await prisma.$transaction([
      prisma.listingSource.create({ data: { ...sourceRow, listingId: decision.targetId } }),
      prisma.listing.update({
        where: { id: decision.targetId },
        data: {
          lastSeen: now,
          likelyClosed: item.active ? false : undefined,
          mergedFrom: { push: mergedFromEntry },
          ...(item.salary ? { salary: item.salary } : {}),
          ...(adoptsPostingText
            ? { postingText: item.postingText, postingTextHash: sha256(item.postingText!) }
            : {}),
          ...(adoptsPostingText || reopened ? { scoringConfigHash: null } : {}),
        },
      }),
    ]);
    log(`merged ${item.source}:${item.sourceUid} into listing ${decision.targetId} (${decision.reason})`);
    return "updated";
  }

  await prisma.listing.create({
    data: {
      ...buildListingCreateData(item, company.id, now),
      sources: { create: sourceRow },
    },
  });
  return "new";
}

async function runAdapter(
  adapter: SourceAdapter,
  now: Date,
  fetchImpl: typeof globalThis.fetch,
  log: (m: string) => void,
): Promise<SourceRunSummary> {
  const run = await prisma.ingestRun.create({
    data: { source: adapter.id, startedAt: now },
  });
  const summary: SourceRunSummary = {
    source: adapter.id,
    ok: false,
    itemsSeen: 0,
    itemsNew: 0,
    itemsUpdated: 0,
    itemsFailed: 0,
  };

  // Persist a raw payload the moment the adapter has it — BEFORE parsing — so
  // a parser crash still leaves the payload for debugging. Identical
  // consecutive payloads store only the hash. Last call wins (fallback paths).
  let rawPersisted = false;
  const persistRaw = async (payload: string) => {
    const rawSha = sha256(payload);
    const prev = await prisma.ingestRun.findFirst({
      where: { source: adapter.id, ok: true, NOT: { id: run.id } },
      orderBy: { startedAt: "desc" },
      select: { rawSha256: true },
    });
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        rawSha256: rawSha,
        rawGz: prev?.rawSha256 === rawSha ? null : gzipSync(payload),
      },
    });
    rawPersisted = true;
  };

  try {
    const ctx: FetchContext = {
      fetch: fetchImpl,
      userAgent: DEFAULT_USER_AGENT(),
      now,
      log: (m) => log(`[${adapter.id}] ${m}`),
      saveRaw: persistRaw,
    };
    const result = await adapter.fetch(ctx);

    // Adapters that never called ctx.saveRaw still get their payload stored.
    if (!rawPersisted) await persistRaw(result.rawPayload);

    summary.itemsSeen = result.listings.length;
    for (const item of result.listings) {
      try {
        const outcome = await ingestListing(item, now, log);
        if (outcome === "new") summary.itemsNew += 1;
        else summary.itemsUpdated += 1;
      } catch (err) {
        summary.itemsFailed += 1;
        log(`[${adapter.id}] failed to ingest ${item.sourceUid}: ${String(err)}`);
      }
    }
    summary.ok = true;
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        finishedAt: new Date(),
        ok: true,
        itemsSeen: summary.itemsSeen,
        itemsNew: summary.itemsNew,
        itemsUpdated: summary.itemsUpdated,
        error:
          summary.itemsFailed > 0
            ? `${summary.itemsFailed} of ${summary.itemsSeen} items failed to ingest`
            : null,
      },
    });
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);
    log(`[${adapter.id}] run FAILED: ${summary.error}`);
    await prisma.ingestRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, error: summary.error },
    });
  }
  return summary;
}

/**
 * Listings whose every source row is inactive or unseen this run → likelyClosed.
 * Clearing scoringConfigHash is what makes the "posting closed" disqualifier
 * actually fire: without it a listing that closes after being scored would keep
 * its score and stay visible forever.
 */
async function markLikelyClosed(runStart: Date): Promise<number> {
  const result = await prisma.listing.updateMany({
    where: {
      likelyClosed: false,
      sources: { none: { active: true, lastSeen: { gte: runStart } } },
    },
    data: { likelyClosed: true, scoringConfigHash: null },
  });
  return result.count;
}

export interface DetailStageOptions {
  now?: Date;
  fetchImpl?: typeof globalThis.fetch;
  /** Defaults to the term/category heuristic; Phase 2 passes a score gate. */
  selector?: (l: DetailCandidate) => boolean;
  /**
   * Gate on the text-independent score, applied in SQL so the candidate set
   * stays small. Listings never scored (gateScore null) are included: a brand
   * new listing should not wait a full cycle for its first fetch.
   */
  minGateScore?: number;
  log?: (m: string) => void;
}

/**
 * Stage 3 as a standalone step, so a full cycle can run
 * ingest → provisional score → detail fetch → final score.
 */
export function runDetailFetch(
  opts: DetailStageOptions = {},
): Promise<{ fetched: number; errors: number }> {
  return runDetailStage(
    opts.now ?? new Date(),
    opts.fetchImpl ?? globalThis.fetch,
    opts.selector ?? defaultDetailSelector,
    opts.log ?? ((m: string) => console.log(m)),
    opts.minGateScore,
  );
}

async function runDetailStage(
  now: Date,
  fetchImpl: typeof globalThis.fetch,
  selector: (l: DetailCandidate) => boolean,
  log: (m: string) => void,
  minGateScore?: number,
): Promise<{ fetched: number; errors: number }> {
  const refetchDays = Number(process.env.DETAIL_REFETCH_DAYS ?? 14);
  const maxPerRun = Number(process.env.DETAIL_MAX_PER_RUN ?? 250);
  const staleBefore = new Date(now.getTime() - refetchDays * 24 * 60 * 60 * 1000);

  // Narrow select: only what the selector needs (postingText alone can be
  // 20KB/row). Never-fetched listings first, then stalest refetches, so a
  // sustained influx of new listings can't starve refreshes forever.
  const candidates = await prisma.listing.findMany({
    where: {
      likelyClosed: false,
      dismissed: false,
      disqualified: false,
      ...(minGateScore === undefined
        ? {}
        : { OR: [{ gateScore: { gte: minGateScore } }, { gateScore: null }] }),
      AND: [
        {
          OR: [
            { detailFetchedAt: null },
            { detailFetchedAt: { lt: staleBefore }, detailFetchStatus: { not: "http_404" } },
          ],
        },
      ],
    },
    select: DETAIL_CANDIDATE_SELECT,
    orderBy: [
      { detailFetchedAt: { sort: "asc", nulls: "first" } },
      { firstSeen: "desc" },
    ],
  });

  const selectedIds = candidates.filter(selector).slice(0, maxPerRun).map((c) => c.id);
  const selected = await prisma.listing.findMany({
    where: { id: { in: selectedIds } },
    select: { id: true, url: true, postingText: true, requisitionId: true, deadline: true },
  });
  const ctx: DetailContext = {
    fetch: fetchImpl,
    userAgent: DEFAULT_USER_AGENT(),
    now,
    log: (m) => log(`[detail] ${m}`),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    robotsCache: new Map(),
    urlCache: new Map(),
  };

  let fetched = 0;
  let errors = 0;
  for (const listing of selected) {
    let result: DetailResult;
    try {
      result = await fetchDetail(listing.url, ctx);
    } catch (err) {
      errors += 1;
      log(`[detail] ${listing.id} threw: ${String(err)}`);
      continue;
    }
    const richer =
      result.postingText &&
      (!listing.postingText || listing.postingText.length < result.postingText.length);
    await prisma.listing.update({
      where: { id: listing.id },
      data: {
        atsKind: result.atsKind,
        detailFetchedAt: now,
        detailFetchStatus: result.status,
        // New posting text (or a CHANGED deadline) invalidates the stored
        // score: clearing the config hash makes the next pass pick this up.
        // An unchanged deadline must not invalidate, or every re-fetch would
        // force a pointless rescore.
        ...(richer
          ? {
              postingText: result.postingText,
              postingTextHash: sha256(result.postingText!),
              scoringConfigHash: null,
            }
          : {}),
        ...(result.deadline &&
        result.deadline.getTime() !== (listing.deadline?.getTime() ?? NaN)
          ? { deadline: result.deadline, scoringConfigHash: null }
          : {}),
        ...(result.requisitionId && !listing.requisitionId
          ? { requisitionId: result.requisitionId }
          : {}),
      },
    });
    fetched += 1;
    if (result.status !== "ok") errors += 1;
  }
  return { fetched, errors };
}

/** Null out gzipped payloads past the retention window (rows are kept). */
async function pruneRawPayloads(now: Date): Promise<void> {
  const retentionDays = Number(process.env.RAW_RETENTION_DAYS ?? 30);
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  await prisma.ingestRun.updateMany({
    where: { startedAt: { lt: cutoff }, rawGz: { not: null } },
    data: { rawGz: null },
  });
}

export async function runIngestion(opts: PipelineOptions = {}): Promise<RunSummary> {
  const now = opts.now ?? new Date();
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const log = opts.log ?? ((m: string) => console.log(m));
  const registry = opts.adapterOverride ?? adapters;
  const selected = opts.sources
    ? registry.filter((a) => opts.sources!.includes(a.id))
    : registry;

  const sources: SourceRunSummary[] = [];
  for (const adapter of selected) {
    sources.push(await runAdapter(adapter, now, fetchImpl, log));
  }

  // Only flag likely-closed when every adapter reported successfully AND no
  // per-item failures occurred — a source outage or a systematic ingest bug
  // must not mass-flag a source's catalog as closed.
  let likelyClosed = 0;
  if (
    sources.length === registry.length &&
    sources.every((s) => s.ok && s.itemsFailed === 0)
  ) {
    likelyClosed = await markLikelyClosed(now);
  }

  let detail = { fetched: 0, errors: 0 };
  if (!opts.skipDetail) {
    detail = await runDetailStage(
      now,
      fetchImpl,
      opts.detailSelector ?? defaultDetailSelector,
      log,
    );
  }

  await pruneRawPayloads(now);

  return {
    startedAt: now,
    finishedAt: new Date(),
    sources,
    likelyClosed,
    detailFetched: detail.fetched,
    detailErrors: detail.errors,
  };
}
