import { NextResponse, type NextRequest } from "next/server";
import { identityFromHeaders, isAllowedUser, isPublicPath } from "@/lib/auth";

/**
 * The outer gate: every request must arrive carrying an identity that Authelia
 * asserted and that matches `ALLOWED_USER`.
 *
 * This is the FIRST of two layers, not the only one. Every Server Action
 * re-checks the same headers through `lib/auth-guard.ts`, and
 * `/api/applications/export` does too. A bug in the matcher below should cost
 * a 401, not the whole catalog.
 *
 * A request with no identity header has not been through Authelia at all —
 * which, if the deployment is correct, means it did not come through Traefik.
 * It gets a flat 401 rather than a redirect: Authelia owns the login flow, and
 * this app has no page to send anyone to.
 */
export default function proxy(req: NextRequest) {
  if (isPublicPath(req.nextUrl.pathname)) return NextResponse.next();

  const identity = identityFromHeaders(req.headers);
  if (isAllowedUser(identity)) return NextResponse.next();

  return NextResponse.json(
    {
      error: identity
        ? "this account is not the one this tracker is configured for"
        : "authentication required",
    },
    { status: identity ? 403 : 401 },
  );
}

export const config = {
  /**
   * Everything except Next's own static output and the favicon.
   *
   * `public/` is NOT excluded, on purpose: files there would otherwise be
   * served to anonymous callers, and a resume lives at `public/resume.pdf`.
   * `_next/image` is not excluded either — the optimizer serves any local path
   * it is given, so excluding it would put every image in `public/` outside
   * the gate.
   */
  matcher: ["/((?!_next/static|favicon.ico).*)"],
};
