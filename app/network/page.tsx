import type { Metadata } from "next";
import { loadCompanyNames, loadContacts } from "@/lib/networking/contacts";
import NetworkView from "./NetworkView";

export const metadata: Metadata = {
  title: "Network · Internship Tracker",
  description: "People you know at each company, and where each conversation stands.",
};

// Contacts change from the contact page and (later) from the worker's daily
// follow-up recompute, so there is nothing worth caching.
export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NetworkPage({ searchParams }: PageProps<"/network">) {
  const params = await searchParams;
  // `?add=1&company=Stripe` comes from a listing's "People at" section.
  const company = (first(params.company) ?? "").slice(0, 200);
  const adding = first(params.add) === "1";
  // `?companyKey=stripe` comes from a tracker card's contacts badge: an exact
  // match on Company.normalizedName, so the page shows who the badge counted.
  const companyKey = (first(params.companyKey) ?? "").slice(0, 200) || null;

  // Sequential, like /tracker: concurrent queries through the `prisma dev`
  // proxy intermittently fail with "bind message supplies N parameters".
  const contacts = await loadContacts();
  const companyNames = await loadCompanyNames();

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <NetworkView
        contacts={contacts}
        companyNames={companyNames}
        initialAdd={adding ? { company } : null}
        initialQuery={adding ? "" : company}
        initialCompanyKey={companyKey}
        nowIso={new Date().toISOString()}
      />
    </div>
  );
}
