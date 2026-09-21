/**
 * Identity, from Authelia's forward-auth headers.
 *
 * There is no login flow in this app and no session of its own. Authelia sits
 * in front as a Traefik middleware, authenticates the request, and forwards it
 * with `Remote-User` / `Remote-Email` set. This module's whole job is to read
 * those and decide whether the person they name is the one person allowed in.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY MODEL — read this before changing anything here.               │
 * │                                                                         │
 * │ These headers are TRUSTED. They are trusted because Traefik strips any  │
 * │ client-supplied copy and replaces them with what Authelia returned, and │
 * │ because nothing but Traefik can reach this container. That second half  │
 * │ is not a nicety: anyone who can open a socket to :3000 directly can set │
 * │ `Remote-Email` to whatever they like and is then indistinguishable from │
 * │ the owner.                                                              │
 * │                                                                         │
 * │ So the network isolation in deploy/compose.tracker.yml — app on         │
 * │ traefik_net + an internal tracker_net, NOT on the shared apps_net — is  │
 * │ load-bearing. Putting this container back on a shared network hands     │
 * │ every other container on it a valid login.                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

/** What Authelia sets and Traefik forwards, in order of preference. */
export const IDENTITY_HEADERS = ["remote-email", "remote-user"] as const;

/**
 * The single account allowed in. One identity, from the environment — there is
 * no user table, no roles and no sign-up.
 *
 * **Fails closed.** An unset or blank `ALLOWED_USER` denies everyone rather
 * than admitting anyone Authelia happens to authenticate. Authelia's own
 * access control may well be broader than this app wants (a `default_policy`
 * covering every domain admits every user), so this is the narrowing step, not
 * a duplicate of it.
 *
 * Matched against `Remote-Email` OR `Remote-User`, so it works whether the
 * forward-auth middleware forwards the address or just the username.
 */
export function isAllowedUser(value: string | null | undefined): boolean {
  const allowed = (process.env.ALLOWED_USER ?? "").trim().toLowerCase();
  if (allowed === "") return false;
  const candidate = (value ?? "").trim().toLowerCase();
  if (candidate === "") return false;
  return candidate === allowed;
}

/** The identity Authelia asserted, or null when the headers are absent. */
export function identityFromHeaders(headers: Headers): string | null {
  for (const name of IDENTITY_HEADERS) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * Paths reachable WITHOUT an identity header. Exactly one, matched exactly
 * rather than by prefix so `/api/healthz-and-then-some` cannot slip past.
 *
 * `/api/health` is the container healthcheck. Docker has no session and does
 * not pass through Traefik, so an authenticated healthcheck would report the
 * app permanently unhealthy — and the worker waits on the app being healthy,
 * so the whole stack would never start. It returns liveness only, never data.
 *
 * It is also excluded from the Traefik middleware, so Authelia never sees it.
 */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/api/health";
}
