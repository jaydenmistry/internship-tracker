import NextAuth from "next-auth";
import { authConfig } from "@/lib/auth.config";

/**
 * The Auth.js instance.
 *
 * `auth` is the session reader used by `proxy.ts`, Server Components and the
 * Server Action guard in `lib/auth-guard.ts`. `handlers` backs the
 * `/api/auth/[...nextauth]` route.
 */
export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
