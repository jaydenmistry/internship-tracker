import { handlers } from "@/lib/auth";

/**
 * The OIDC handshake with Authentik. Deliberately reachable without a session —
 * see `isPublicPath` in lib/auth.config.ts; gating it would make signing in
 * impossible.
 */
export const { GET, POST } = handlers;
