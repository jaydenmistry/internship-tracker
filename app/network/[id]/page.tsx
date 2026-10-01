import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadCompanyNames, loadContact } from "@/lib/networking/contacts";
import { displayTimeZone, followUpContext, peekFollowUpState } from "@/lib/networking/followups";
import { loadCompanyListings, loadTimeline } from "@/lib/networking/messages";
import { loadContactReferrals, loadReferrableApplications } from "@/lib/networking/referrals";
import ContactView from "./ContactView";
import { draftingConfigured } from "@/lib/claude/draftClient";
import { parseDraftParam } from "../draft-state";

export const metadata: Metadata = {
  title: "Contact · Internship Tracker",
  description: "One contact's details, messages and what's due next.",
};

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function ContactPage({ params, searchParams }: PageProps<"/network/[id]">) {
  const { id } = await params;
  const query = await searchParams;
  // Sequential, like the other pages: concurrent queries through the
  // `prisma dev` proxy intermittently fail with "bind message" errors.
  const contact = await loadContact(id);
  if (!contact) notFound();
  const timeline = await loadTimeline(id);
  const listings = await loadCompanyListings(contact.companyId);
  const referrals = await loadContactReferrals(id);
  const referrable = await loadReferrableApplications();
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
        referrals={referrals}
        referrable={referrable}
        dueKind={state?.dueKind ?? null}
        companyNames={companyNames}
        nowIso={now.toISOString()}
        timeZone={displayTimeZone()}
        drafting={
          draftingConfigured()
            ? { connected: true, reason: null }
            : { connected: false, reason: "Claude not connected — set CLAUDE_CODE_OAUTH_TOKEN (see /network/settings)." }
        }
        initialDraft={(() => {
          const type = parseDraftParam(first(query.draft));
          if (!type) return null;
          const listingId = first(query.listing) ?? null;
          // Only a listing at this contact's company can be preselected.
          return { type, listingId: listings.some((l) => l.id === listingId) ? listingId : null };
        })()}
      />
    </div>
  );
}
