import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isPublicPath } from "@/lib/auth.config";

/**
 * The outer gate: nothing is reachable without a session except the sign-in
 * handshake and the container healthcheck.
 *
 * This is the FIRST of two layers, not the only one. Next's proxy is documented
 * as running separately from render code and, in optimized deployments, at the
 * edge — so it is the wrong and only place to enforce authorization. Every
 * Server Action re-checks the session itself through `lib/auth-guard.ts`, and
 * every route handler does the same. A bug in the matcher below should cost a
 * redirect, not the whole catalog.
 *
 * A browser navigation gets a redirect to /signin; anything else (a Server
 * Action POST, a fetch, an API call) gets a bare 401, because redirecting a
 * non-navigation request to an HTML page just produces a confusing parse error
 * at the caller.
 */
export default auth((req) => {
  const { pathname, search } = req.nextUrl;

  if (isPublicPath(pathname)) return NextResponse.next();
  if (req.auth) return NextResponse.next();

  const wantsHtml = req.headers.get("accept")?.includes("text/html") ?? false;
  const isNavigation = req.method === "GET" && wantsHtml;

  if (!isNavigation) {
    return NextResponse.json({ error: "authentication required" }, { status: 401 });
  }

  const signin = new URL("/signin", req.nextUrl.origin);
  // Where to return to after signing in. Only the path is carried, never an
  // absolute URL — an attacker-supplied absolute `callbackUrl` is how open
  // redirects happen.
  if (pathname !== "/") signin.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(signin);
});

export const config = {
  /**
   * Everything except Next's own static output and the favicon.
   *
   * Without a matcher, proxy runs on every request including `_next/static`,
   * which would make the gate block its own stylesheets. `public/` files are
   * NOT excluded on purpose: anything dropped in there would otherwise be
   * served to anonymous callers, and this app has had a resume sitting in that
   * directory before.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
