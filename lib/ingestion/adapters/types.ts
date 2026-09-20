import { z } from "zod";

/**
 * The normalized shape every adapter emits. Everything crossing this boundary
 * is untrusted and must pass this schema before touching the pipeline.
 */
export const NormalizedListingSchema = z.object({
  /** Adapter id, e.g. "simplify". Plain string — new sources need no migration. */
  source: z.string().min(1),
  /** Stable per-source id: Simplify's UUID; a URL hash for scraped sources. */
  sourceUid: z.string().min(1),
  company: z.string().min(1),
  title: z.string().min(1),
  url: z.url(),
  locations: z.array(z.string()).default([]),
  remote: z.boolean().default(false),
  category: z.string().optional(),
  terms: z.array(z.string()).default([]),
  sponsorship: z.string().optional(),
  /** Display string as the source gives it, e.g. "$58-$70/hr". */
  salary: z.string().optional(),
  degrees: z.array(z.string()).default([]),
  /** Description text if the source provides any (most don't — stage 3 fills it). */
  postingText: z.string().optional(),
  postedAt: z.date().optional(),
  updatedAt: z.date().optional(),
  deadline: z.date().optional(),
  /** Whether the source currently shows this listing as open. */
  active: z.boolean(),
  /** True when the source flags the company as FAANG+ (Simplify README 🔥). */
  companyFaangPlus: z.boolean().default(false),
  /** The original source record, persisted verbatim on ListingSource.raw. */
  raw: z.unknown(),
});

export type NormalizedListing = z.infer<typeof NormalizedListingSchema>;

/** Injected into adapters so tests never touch the network. */
export interface FetchContext {
  fetch: typeof globalThis.fetch;
  userAgent: string;
  now: Date;
  log(message: string): void;
  /**
   * Persist the raw payload IMMEDIATELY after fetching, before any parsing —
   * so a parser crash still leaves the payload on the IngestRun for debugging.
   * Adapters should call this as soon as they have the authoritative payload
   * (calling it again overwrites — last call wins, e.g. on a fallback path).
   * Provided by the pipeline; absent in unit tests unless the test wants it.
   */
  saveRaw?(payload: string): Promise<void>;
}

/**
 * Outcome of re-normalizing ONE stored source record. `error` is shown to the
 * user when a merge split can't rebuild the listing, so it names the reason.
 */
export type RecordNormalizeResult =
  | { ok: true; listing: NormalizedListing }
  | { ok: false; error: string };

export interface SourceAdapter {
  /** Stable source id, e.g. "simplify" — becomes ListingSource.source. */
  id: string;
  displayName: string;
  /**
   * Re-normalize ONE verbatim source record (a stored `ListingSource.raw`)
   * back into a NormalizedListing, through the SAME per-record mapping
   * `fetch` uses — nothing about the mapping may live in two places.
   *
   * Splitting an incorrect merge (lib/ingestion/split.ts) is the only caller:
   * it rebuilds the merged-away listing from the raw record the merge kept.
   * Optional, so an adapter whose records can't stand alone simply refuses
   * the split instead of every adapter having to implement it.
   */
  normalizeRecord?(raw: unknown): RecordNormalizeResult;
  /**
   * Fetch and normalize all current listings. Throwing is fine — the pipeline
   * records the failure on this adapter's IngestRun and continues with others.
   * Also returns the raw payload for IngestRun persistence (raw is captured
   * BEFORE parsing so parser breakage stays debuggable).
   */
  fetch(ctx: FetchContext): Promise<AdapterResult>;
}

export interface AdapterResult {
  listings: NormalizedListing[];
  /** Raw payload as fetched (pre-parse), for gzipped IngestRun.rawGz storage. */
  rawPayload: string;
}
