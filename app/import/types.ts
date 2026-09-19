import type { ImportRow, MatchVerdict } from "@/lib/applications/import";
import type { CommitSummary } from "@/lib/applications/commit";

/**
 * Wire shapes for the import flow.
 *
 * The catalog is ~2,860 listings and stays on the server: the browser only ever
 * receives the handful of candidates the matcher actually proposed for a row.
 * Every string here originates in scraped listings or in text the user pasted,
 * so it is rendered as plain text — never as HTML.
 */

export interface ReviewCandidate {
  listingId: string;
  company: string;
  title: string;
  /** Listing locations, already joined for display. */
  location: string;
  score: number | null;
  url: string;
  /** True when an Application row already points at this listing. */
  alreadyApplied: boolean;
  /** 0–1, from the matcher. */
  confidence: number;
  reasons: string[];
}

export interface ReviewRow {
  /** Stable per-row key: the line number is unique within one paste. */
  key: string;
  row: ImportRow;
  verdict: MatchVerdict;
  best: ReviewCandidate | null;
  alternatives: ReviewCandidate[];
}

export interface ParseIssue {
  lineNumber: number;
  raw: string;
  reason: string;
}

export type AnalyzeResult =
  | { ok: true; rows: ReviewRow[]; issues: ParseIssue[] }
  | { ok: false; message: string };

export type CommitResult =
  | { ok: true; summary: CommitSummary }
  | { ok: false; message: string };

export interface CatalogHit {
  listingId: string;
  company: string;
  title: string;
  location: string;
  score: number | null;
  alreadyApplied: boolean;
}

export type SearchResult =
  | { ok: true; hits: CatalogHit[] }
  | { ok: false; message: string };
