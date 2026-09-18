/**
 * Cross-source merge decision. Pure: no I/O, no DB, no clock — the pipeline
 * pre-filters candidates to the same normalized company + location bucket and
 * hands them here.
 *
 * Bias: toward NOT merging. A wrong merge silently hides a real listing, so
 * ambiguity always creates a separate row (the UI can split later via
 * Listing.mergedFrom, but a hidden listing is invisible).
 */

import { canonicalizeUrl, titleSimilarity } from "./normalize";

export interface MergeCandidate {
  id: string;
  url: string;
  requisitionId: string | null;
  dedupKey: string;
  normalizedTitle: string;
}

export interface MergeInput {
  url: string;
  requisitionId: string | null;
  dedupKey: string;
  normalizedTitle: string;
}

export type MergeDecision =
  | { action: "merge"; targetId: string; reason: string }
  | { action: "create"; reason: string };

export const DEFAULT_FUZZY_THRESHOLD = 0.87;

function canonicalHostPath(url: string): { host: string; path: string } | null {
  try {
    const u = new URL(canonicalizeUrl(url));
    return { host: u.host, path: u.pathname };
  } catch {
    return null;
  }
}

/**
 * Decide whether `incoming` merges into one of `candidates`.
 *
 * Rules, in order:
 * 1. Requisition-id equality proves identity — immediate merge, regardless of
 *    dedupKey or fuzzy score.
 * 2. A candidate is "in play" if its dedupKey matches exactly OR its title
 *    similarity meets the threshold (default 0.87).
 * 3. HARD GUARD — drop any in-play candidate with comparable, DIFFERING
 *    identity: both req ids non-null and different, or canonical URLs on the
 *    same host with different paths. Different hosts with no shared req id are
 *    INCONCLUSIVE (aggregator vs ATS), not differing — those stay in play.
 * 4. Exactly one survivor → merge. Zero → create. More than one → create
 *    (ambiguous: e.g. one aggregator row matching three same-title
 *    requisitions — never guess).
 */
export function decideMerge(
  incoming: MergeInput,
  candidates: MergeCandidate[],
  opts?: { fuzzyThreshold?: number },
): MergeDecision {
  const threshold = opts?.fuzzyThreshold ?? DEFAULT_FUZZY_THRESHOLD;

  // Rule 1: proven identity short-circuits everything, fuzzy score included.
  if (incoming.requisitionId !== null) {
    const proven = candidates.find((c) => c.requisitionId === incoming.requisitionId);
    if (proven) {
      return {
        action: "merge",
        targetId: proven.id,
        reason: `req id match: ${incoming.requisitionId}`,
      };
    }
  }

  // Rule 2: in-play set.
  const inPlay: { candidate: MergeCandidate; similarity: number; viaKey: boolean }[] = [];
  for (const candidate of candidates) {
    const viaKey = candidate.dedupKey === incoming.dedupKey;
    const similarity = titleSimilarity(incoming.normalizedTitle, candidate.normalizedTitle);
    if (viaKey || similarity >= threshold) inPlay.push({ candidate, similarity, viaKey });
  }

  if (inPlay.length === 0) {
    return {
      action: "create",
      reason: `no candidates in play (0 of ${candidates.length} matched dedupKey or fuzzy >= ${threshold})`,
    };
  }

  // Rule 3: hard guard — drop comparable-but-differing identities.
  const incomingHostPath = canonicalHostPath(incoming.url);
  const survivors: typeof inPlay = [];
  const dropped: string[] = [];
  for (const entry of inPlay) {
    const { candidate } = entry;
    if (
      incoming.requisitionId !== null &&
      candidate.requisitionId !== null &&
      candidate.requisitionId !== incoming.requisitionId
    ) {
      dropped.push(
        `${candidate.id}: differing req ids (${incoming.requisitionId} vs ${candidate.requisitionId})`,
      );
      continue;
    }
    const candidateHostPath = canonicalHostPath(candidate.url);
    if (
      incomingHostPath !== null &&
      candidateHostPath !== null &&
      incomingHostPath.host === candidateHostPath.host &&
      incomingHostPath.path !== candidateHostPath.path
    ) {
      dropped.push(
        `${candidate.id}: same host ${incomingHostPath.host}, differing paths (${incomingHostPath.path} vs ${candidateHostPath.path})`,
      );
      continue;
    }
    survivors.push(entry);
  }

  // Rule 4.
  if (survivors.length === 1) {
    const s = survivors[0];
    const how = s.viaKey
      ? "exact dedupKey match"
      : `fuzzy candidate ${s.similarity.toFixed(2)}`;
    return {
      action: "merge",
      targetId: s.candidate.id,
      reason: `single ${how}, identities inconclusive`,
    };
  }
  if (survivors.length === 0) {
    return {
      action: "create",
      reason: `all ${inPlay.length} in-play candidate(s) dropped by identity guard: ${dropped.join("; ")}`,
    };
  }
  return {
    action: "create",
    reason: `${survivors.length} candidates survived guard — ambiguous, creating separate listing`,
  };
}
