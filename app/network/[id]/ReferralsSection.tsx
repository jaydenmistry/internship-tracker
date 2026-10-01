"use client";

import { useMemo, useState, useTransition } from "react";
import type { ReferralApplication } from "@/lib/networking/referrals";
import { setReferralAction } from "../actions";

/**
 * The applications this contact referred you for, and a way to record one.
 * Recording marks the contact REFERRED (server side, same transaction); the
 * tracker card shows "referred by {name}". Applications at this contact's
 * company are listed first in the picker.
 */

interface Props {
  contactId: string;
  contactName: string;
  companyKey: string | null;
  referrals: ReferralApplication[];
  applications: ReferralApplication[];
}

export default function ReferralsSection({ contactId, contactName, companyKey, referrals, applications }: Props) {
  const [choice, setChoice] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const options = useMemo(() => {
    const mine = new Set(referrals.map((r) => r.applicationId));
    return applications
      .filter((a) => !mine.has(a.applicationId))
      .sort((a, b) => Number(b.companyKey === companyKey) - Number(a.companyKey === companyKey));
  }, [applications, referrals, companyKey]);

  const run = (applicationId: string, contact: string | null, done?: () => void) => {
    setError(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof setReferralAction>>;
      try {
        res = await setReferralAction({ applicationId, contactId: contact });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) done?.();
      else setError(res.message);
    });
  };

  return (
    <section aria-label="Referrals" className="rounded border border-line bg-panel" data-testid="referrals">
      <h2 className="border-b border-line px-3 py-2 font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
        Referrals
      </h2>
      <div className="flex flex-col gap-2 px-3 py-2 text-[13px]">
        {referrals.length === 0 ? (
          <p className="text-[12px] text-faint">{contactName} hasn&apos;t referred you for anything yet.</p>
        ) : (
          <ul className="space-y-1">
            {referrals.map((r) => (
              <li key={r.applicationId} className="flex items-baseline gap-2">
                <span className="font-medium">{r.company}</span>
                <span className="min-w-0 truncate text-dim">{r.role}</span>
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => run(r.applicationId, null)}
                  className="ml-auto shrink-0 text-[12px] text-faint hover:text-bad"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
        {options.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Application they referred you for"
              value={choice}
              onChange={(e) => setChoice(e.target.value)}
              className="h-7 min-w-0 max-w-full flex-1 rounded border border-line bg-raised px-1 text-[12px]"
            >
              <option value="">Record a referral for…</option>
              {options.map((a) => (
                <option key={a.applicationId} value={a.applicationId}>
                  {a.company} — {a.role}
                  {a.referredBy ? ` (now: ${a.referredBy.name})` : ""}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || choice === ""}
              onClick={() => run(choice, contactId, () => setChoice(""))}
              className="rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink disabled:opacity-60"
            >
              {pending ? "Saving…" : "Record"}
            </button>
          </div>
        ) : (
          referrals.length === 0 && (
            <p className="text-[12px] text-faint">Track an application first (Listings or /import) to record a referral on it.</p>
          )
        )}
        {error && (
          <p role="alert" className="text-[12px] text-bad">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
