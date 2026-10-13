/**
 * How many drafts may run at once, across every kind (networking messages and
 * cover letters). Each one spawns a Claude Code process of a couple of hundred
 * MB; one user never needs more than two at a time, and this stops a
 * double-click storm from starting ten.
 */
export const MAX_CONCURRENT_DRAFTS = 2;

let inFlight = 0;

/** Runs `fn` if a slot is free; otherwise throws what `busy()` returns. */
export async function withDraftSlot<T>(fn: () => Promise<T>, busy: () => Error): Promise<T> {
  if (inFlight >= MAX_CONCURRENT_DRAFTS) throw busy();
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
  }
}
