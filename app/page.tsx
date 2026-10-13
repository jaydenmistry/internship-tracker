import { loadListingRows } from "@/lib/listings/query";
import { loadSavedViews } from "@/lib/listings/views";
import ListingsTable from "./listings/ListingsTable";
import { VIEW_QUERY_KEYS } from "./listings/table-state";

/**
 * The ranked listings table — the app's primary view.
 *
 * The whole eligible catalog (~2,900 lean rows) is loaded once here and handed
 * to the client, which sorts and filters it in memory: every interaction is
 * then a local array pass instead of a round trip. The rows are deliberately
 * thin — anything only the detail panel needs is fetched per row on demand.
 *
 * Filters and sort live in the URL query, so a reload or a bookmark keeps
 * them. A bare `/` opens the saved view marked as default, if there is one.
 */
export const dynamic = "force-dynamic";

export default async function Home({ searchParams }: PageProps<"/">) {
  const [rows, views, params] = await Promise.all([
    loadListingRows(),
    loadSavedViews(),
    searchParams,
  ]);

  // Only parameters the table understands count: a stray `?utm_source=` must
  // not stop the default view from opening.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (!VIEW_QUERY_KEYS.has(key)) continue;
    for (const v of Array.isArray(value) ? value : [value]) if (v !== undefined) query.append(key, v);
  }
  const initialQuery = query.size > 0 ? query.toString() : (views.find((v) => v.isDefault)?.query ?? "");

  // "Now" is fixed on the server so the first paint and hydration agree on
  // every relative date; the client takes over the clock after mount.
  return (
    <ListingsTable
      rows={rows}
      nowIso={new Date().toISOString()}
      initialQuery={initialQuery}
      views={views}
    />
  );
}
