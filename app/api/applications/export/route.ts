import { loadTrackerApplications } from "@/lib/applications/tracker";
import { applicationsToCsv } from "@/lib/applications/csv";
import { requireSession } from "@/lib/auth-guard";

// Always reflect current data — never serve a cached export.
export const dynamic = "force-dynamic";

/**
 * GET → applications as CSV, in the column layout /import reads back, so an
 * export round-trips. Formula-injection guarding happens in applicationsToCsv.
 *
 * This route hands out every application the user has, so it checks the session
 * itself rather than trusting `proxy.ts` to have matched `/api/*` — the file
 * most worth stealing should not be protected by a regex alone.
 */
export async function GET() {
  try {
    await requireSession();
  } catch {
    return Response.json({ error: "authentication required" }, { status: 401 });
  }

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
