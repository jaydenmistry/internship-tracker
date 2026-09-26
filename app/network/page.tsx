import type { Metadata } from "next";
import { loadCompanyNames, loadContacts } from "@/lib/networking/contacts";
import { displayTimeZone, followUpContext, loadDueFollowUps } from "@/lib/networking/followups";
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
  const now = new Date();
  // Recomputes the time-sensitive contacts first (a contact that went COLD
  // overnight), so this page is right even with the digest cron off — and it
  // must run BEFORE loadContacts so the table shows the fresh statuses.
  const due = await loadDueFollowUps(await followUpContext(undefined, now));
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
        due={due.map((d) => ({ ...d, dueAt: d.dueAt.toISOString() }))}
        nowIso={now.toISOString()}
        timeZone={displayTimeZone()}
      />
    </div>
  );
}
