import { auth } from "@/lib/auth";
import { isAllowedEmail } from "@/lib/auth.config";

/**
 * The inner gate, for Server Actions and route handlers.
 *
 * `proxy.ts` already blocks unauthenticated requests, but it is a redirect
 * layer that runs outside render and can be bypassed by a matcher mistake or a
 * deployment that routes around it. Every mutation re-checks here, so the
 * security property does not depend on a regex.
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
  email: string;
}

/**
 * Resolves the caller, or throws. The allowlist is re-applied here too: a
 * session minted before `ALLOWED_EMAIL` changed must not keep working.
 */
export async function requireSession(): Promise<AuthedUser> {
  const session = await auth();
  const email = session?.user?.email ?? null;
  if (!email || !isAllowedEmail(email)) throw new NotAuthenticatedError();
  return { email };
}

/**
 * Wraps a Server Action so it cannot run unauthenticated.
 *
 * Used instead of a bare `await requireSession()` line inside each action,
 * because a wrapper cannot be forgotten halfway down a function the way a
 * statement can — the action's own body never begins until the check passes.
 */
export function guarded<Args extends unknown[], Result>(
  action: (...args: Args) => Promise<Result>,
): (...args: Args) => Promise<Result> {
  return async (...args: Args): Promise<Result> => {
    await requireSession();
    return action(...args);
  };
}
