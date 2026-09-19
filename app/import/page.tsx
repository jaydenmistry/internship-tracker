import type { Metadata } from "next";
import ImportFlow from "./ImportFlow";

export const metadata: Metadata = {
  title: "Import applications · Internship Tracker",
  description: "Bulk-import roles you have already applied to.",
};

/**
 * Server Component shell. All the interactive work lives in ImportFlow, which
 * talks to the server through the actions in ./actions.ts — the listing catalog
 * is never sent to the browser.
 */
export default function ImportPage() {
  return (
    <div className="flex flex-1 flex-col px-4 py-4">
      <ImportFlow />
    </div>
  );
}
