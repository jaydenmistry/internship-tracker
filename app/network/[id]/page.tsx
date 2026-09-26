import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadCompanyNames, loadContact } from "@/lib/networking/contacts";
import { displayTimeZone, followUpContext, peekFollowUpState } from "@/lib/networking/followups";
import { loadCompanyListings, loadTimeline } from "@/lib/networking/messages";
import ContactView from "./ContactView";

export const metadata: Metadata = {
  title: "Contact · Internship Tracker",
  description: "One contact's details, messages and what's due next.",
};

export const dynamic = "force-dynamic";

export default async function ContactPage({ params }: PageProps<"/network/[id]">) {
  const { id } = await params;
  // Sequential, like the other pages: concurrent queries through the
  // `prisma dev` proxy intermittently fail with "bind message" errors.
  const contact = await loadContact(id);
  if (!contact) notFound();
  const timeline = await loadTimeline(id);
  const listings = await loadCompanyListings(contact.companyId);
  const companyNames = await loadCompanyNames();
  const now = new Date();
  const state = await peekFollowUpState(id, await followUpContext(undefined, now));
  // Show the state as of now, not as last stored: opened directly (not via
  // /network, which recomputes), a contact may have gone COLD since.
  const shown = state
    ? {
        ...contact,
        status: state.status,
        nextFollowUpAt: state.nextFollowUpAt?.toISOString() ?? null,
        followUpsSent: state.followUpsSent,
      }
    : contact;

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <ContactView
        contact={shown}
        timeline={timeline}
        listings={listings}
        dueKind={state?.dueKind ?? null}
        companyNames={companyNames}
        nowIso={now.toISOString()}
        timeZone={displayTimeZone()}
      />
    </div>
  );
}
