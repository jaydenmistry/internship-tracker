import { headers } from "next/headers";
import { identityFromHeaders, isAllowedUser } from "@/lib/auth";

/**
 * The inner gate, for Server Actions and route handlers.
 *
 * `proxy.ts` already rejects requests without a valid identity header, but it
 * is a layer that runs outside render and can be bypassed by a matcher mistake
 * or a deployment that routes around it. Every mutation re-checks here, so the
 * security property does not rest on a regex.
 *
 * Throws rather than returning a flag: a guard whose result can be ignored is
 * one an added code path will eventually ignore.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not signed in.");
    this.name = "NotAuthenticatedError";
  }
}

export interface AuthedUser {
  /** Whatever Authelia asserted — an email address, or a username. */
  user: string;
}

/** Resolves the caller, or throws. */
export async function requireSession(): Promise<AuthedUser> {
  const identity = identityFromHeaders(await headers());
  if (!isAllowedUser(identity)) throw new NotAuthenticatedError();
  return { user: identity as string };
}
