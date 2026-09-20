import type { NextAuthConfig } from "next-auth";
import Authentik from "next-auth/providers/authentik";

/**
 * Auth configuration, kept free of Node-only imports.
 *
 * `proxy.ts` runs this on every request, and Next's proxy is documented as
 * running separately from render code (in optimized deployments, at the edge).
 * Nothing here may reach for Prisma, `node:` built-ins, or anything else that
 * only exists in the Node runtime — sessions are JWTs for exactly that reason,
 * so no database adapter is involved.
 */

/**
 * The single account allowed in. This is a personal tracker: there is no user
 * table, no roles, and no sign-up — one identity, from the environment.
 *
 * **Fails closed.** An unset or blank `ALLOWED_EMAIL` denies everyone rather
 * than admitting anyone who can authenticate against the Authentik tenant. A
 * misconfigured deployment that locks the owner out is recoverable; one that
 * silently admits every user of the identity provider is not.
 */
export function isAllowedEmail(email: string | null | undefined): boolean {
  const allowed = (process.env.ALLOWED_EMAIL ?? "").trim().toLowerCase();
  if (allowed === "") return false;
  const candidate = (email ?? "").trim().toLowerCase();
  if (candidate === "") return false;
  return candidate === allowed;
}

/**
 * Paths reachable WITHOUT a session. Deliberately tiny, and matched exactly
 * rather than by prefix so that `/api/healthz-and-then-some` cannot slip past.
 *
 * - `/signin` is where unauthenticated callers are SENT. Gating it would
 *   redirect it to itself forever.
 * - `/api/auth/*` is the sign-in handshake itself; gating it would make signing
 *   in impossible.
 * - `/api/health` is the container healthcheck. Docker has no session, so an
 *   authenticated healthcheck would report the app permanently unhealthy — and
 *   in `docker-compose.yml` the worker waits on the app being healthy, so the
 *   whole stack would never start. It returns liveness only, never data.
 */
export function isPublicPath(pathname: string): boolean {
  if (pathname === "/signin" || pathname === "/api/health") return true;
  return pathname === "/api/auth" || pathname.startsWith("/api/auth/");
}

export const authConfig = {
  providers: [
    Authentik({
      clientId: process.env.AUTH_AUTHENTIK_ID,
      clientSecret: process.env.AUTH_AUTHENTIK_SECRET,
      // Authentik wants the application slug and no trailing slash, e.g.
      // https://auth.example.com/application/o/internship-tracker
      issuer: process.env.AUTH_AUTHENTIK_ISSUER,
    }),
  ],
  // JWT, not database sessions: there is one user, and it keeps proxy.ts free
  // of a database round trip on every request.
  session: { strategy: "jwt" },
  callbacks: {
    /**
     * The allowlist is enforced HERE, at sign-in, not only in the UI — a
     * rejected identity never gets a session cookie at all.
     */
    signIn({ profile }) {
      return isAllowedEmail(profile?.email as string | undefined);
    },
    /**
     * Re-checked on every token refresh, so removing `ALLOWED_EMAIL` (or
     * changing it) invalidates an already-issued session rather than letting it
     * live out its natural life.
     */
    jwt({ token }) {
      if (!isAllowedEmail(token.email)) return null;
      return token;
    },
  },
  pages: {
    // One provider and one user, so Auth.js's provider-picker page has nothing
    // to pick; /signin explains the state and offers the single button.
    signIn: "/signin",
    error: "/signin",
  },
  // Authentik is the only identity source; trust the host behind Traefik.
  trustHost: true,
} satisfies NextAuthConfig;
