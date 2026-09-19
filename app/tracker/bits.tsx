"use client";

import Badge from "@/components/Badge";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { absoluteDate, COLUMNS, relativeAge, safeHttpUrl, STATUS_LABELS, STATUS_TONE } from "./state";

/**
 * Small pieces shared by the kanban cards and the list rows. Everything here
 * renders untrusted company/role/notes/url strictly as text; the only href is
 * the http(s)-guarded apply URL.
 */

export function ApplyLink({
  app,
  className = "",
  children,
}: {
  app: Pick<TrackerApplication, "url">;
  className?: string;
  children: React.ReactNode;
}) {
  const href = safeHttpUrl(app.url);
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={`${className} hover:underline decoration-faint underline-offset-2`}
    >
      {children}
    </a>
  );
}

export function Markers({ app }: { app: TrackerApplication }) {
  return (
    <>
      {app.listingId === null && (
        <Badge tone="info" title="Manual application: not linked to a scraped listing">
          manual
        </Badge>
      )}
      {app.likelyClosed && (
        <Badge tone="warn" title="The listing has disappeared from every source; it is likely closed">
          closed?
        </Badge>
      )}
    </>
  );
}

export function RelDate({ iso, nowMs, prefix }: { iso: string | null; nowMs: number; prefix?: string }) {
  return (
    <time dateTime={iso ?? undefined} title={absoluteDate(iso)} className="font-mono tabular-nums">
      {prefix}
      {relativeAge(iso, nowMs)}
    </time>
  );
}

export function StatusSelect({
  app,
  onChange,
  className = "",
}: {
  app: TrackerApplication;
  onChange: (status: AppStatus) => void;
  className?: string;
}) {
  return (
    <select
      aria-label={`Status for ${app.company}, ${app.role}`}
      value={app.status}
      onChange={(e) => onChange(e.target.value as AppStatus)}
      className={`h-6 min-w-0 rounded border border-line bg-raised px-1 text-[12px] ${
        STATUS_TONE[app.status]
      } ${className}`}
    >
      {COLUMNS.map((s) => (
        <option key={s} value={s}>
          {STATUS_LABELS[s]}
        </option>
      ))}
      <option disabled value="">
        ──────────
      </option>
      <option value="NOT_APPLIED">not applied (remove)</option>
    </select>
  );
}
