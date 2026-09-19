import Link from "next/link";

/**
 * Placeholder. The ranked listings table is a later Phase 3 deliverable; this
 * page exists so the shell has a home and the import flow is reachable.
 */
export default function Home() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="text-lg font-semibold tracking-tight">Internship Tracker</h1>
      <p className="mt-2 max-w-prose text-dim">
        The ranked listings table lands in a later deliverable. Until then, start by
        telling the tracker which roles you have already applied to, so they stop
        showing up as new.
      </p>
      <Link
        href="/import"
        className="mt-6 inline-flex items-center rounded border border-line bg-raised px-3 py-1.5 font-medium text-ink transition-colors hover:border-accent hover:text-accent"
      >
        Import applications
      </Link>
    </div>
  );
}
