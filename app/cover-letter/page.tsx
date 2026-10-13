import type { Metadata } from "next";
import Link from "next/link";
import { loadCoverLetterPage, type CoverLetterTarget } from "@/lib/coverletter/letters";
import { loadLetterProfile } from "@/lib/coverletter/profile";
import CoverLetterEditor from "./CoverLetterEditor";

export const metadata: Metadata = {
  title: "Cover letter · Internship Tracker",
  description: "Draft, edit and export a cover letter for one role.",
};

export const dynamic = "force-dynamic";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/cover-letter?listing=<id>` from the listing detail panel, or
 * `/cover-letter?application=<id>` from a tracker card (manual applications
 * have no listing).
 */
export default async function CoverLetterPage({ searchParams }: PageProps<"/cover-letter">) {
  const query = await searchParams;
  const listingId = first(query.listing)?.slice(0, 100);
  const applicationId = first(query.application)?.slice(0, 100);
  const target: CoverLetterTarget | null = applicationId
    ? { applicationId }
    : listingId
      ? { listingId }
      : null;

  const page = target ? await loadCoverLetterPage(target) : null;
  // Sequential, like the other pages: concurrent queries through the
  // `prisma dev` proxy intermittently fail with "bind message" errors.
  const profile = page ? await loadLetterProfile() : null;
  if (!page || !profile) {
    return (
      <div className="px-4 py-6 text-[13px] text-dim">
        <p>
          {target
            ? "That listing or application doesn't exist any more."
            : "Open a cover letter from a listing's detail panel or a tracker card."}
        </p>
        <p className="mt-2">
          <Link href="/" className="text-accent hover:underline">
            ← Listings
          </Link>
          <span className="mx-2 text-faint">·</span>
          <Link href="/tracker" className="text-accent hover:underline">
            Tracker
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="px-4 py-3">
      <CoverLetterEditor page={page} profile={profile} />
    </div>
  );
}
