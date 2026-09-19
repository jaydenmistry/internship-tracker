import { loadListingRows } from "@/lib/listings/query";
import ListingsTable from "./listings/ListingsTable";

/**
 * The ranked listings table — the app's primary view.
 *
 * The whole eligible catalog (~2,900 lean rows) is loaded once here and handed
 * to the client, which sorts and filters it in memory: every interaction is
 * then a local array pass instead of a round trip. The rows are deliberately
 * thin — anything only the detail panel needs is fetched per row on demand.
 */
export const dynamic = "force-dynamic";

export default async function Home() {
  const rows = await loadListingRows();

  // "Now" is fixed on the server so the first paint and hydration agree on
  // every relative date; the client takes over the clock after mount.
  return <ListingsTable rows={rows} nowIso={new Date().toISOString()} />;
}
