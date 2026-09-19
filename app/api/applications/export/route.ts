import { loadTrackerApplications } from "@/lib/applications/tracker";
import { applicationsToCsv } from "@/lib/applications/csv";

// Always reflect current data — never serve a cached export.
export const dynamic = "force-dynamic";

/**
 * GET → applications as CSV, in the column layout /import reads back, so an
 * export round-trips. Formula-injection guarding happens in applicationsToCsv.
 * NOTE (Phase 5): this route exposes every application; proxy.ts auth must
 * cover /api/* before the app is reachable from outside localhost.
 */
export async function GET() {
  const csv = applicationsToCsv(await loadTrackerApplications());
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="applications-${date}.csv"`,
      "cache-control": "no-store",
      // Stops a browser from sniffing the body into something executable.
      "x-content-type-options": "nosniff",
    },
  });
}
