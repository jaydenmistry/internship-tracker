/**
 * Container liveness probe, referenced by the app service's healthcheck in
 * docker-compose.yml.
 *
 * Unauthenticated on purpose: Docker has no session, and the worker waits on
 * this endpoint reporting healthy before it starts. It answers liveness ONLY —
 * no database access, no counts, no version, nothing an anonymous caller could
 * learn from. If this ever needs to report dependency health, that belongs on
 * a separate authenticated route.
 */
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
}
