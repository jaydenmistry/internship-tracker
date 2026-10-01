"use client";

import { useState, useTransition } from "react";
import type { ContactDetail } from "@/lib/networking/contacts";
import { logMessageAction, setManualStatusAction, snoozeAction } from "../actions";
import { DUE_LABELS, dueWhen, relativeAge, type DueKindLabel } from "../state";
import { DRAFT_LABELS } from "../draft-state";

/**
 * What's next for this contact, and the one-click inputs to the follow-up
 * engine: Mark connected, Log meeting, Set status, Snooze. The engine does the
 * rest — nothing here writes a status or a due date directly.
 */

interface Props {
  contact: ContactDetail;
  dueKind: DueKindLabel | null;
  nowMs: number;
  timeZone: string;
  onLogMeeting: () => void;
  /** Opens the draft panel preset to what's due. */
  onDraft: () => void;
  canDraft: boolean;
}

/** "YYYY-MM-DD" of today in `timeZone`, for the date input's min. */
function todayIn(timeZone: string, nowMs: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(nowMs);
}

export default function FollowUpBar({ contact, dueKind, nowMs, timeZone, onLogMeeting, onDraft, canDraft }: Props) {
  const [snoozeDate, setSnoozeDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ ok: boolean; message?: string }>, done?: () => void) => {
    setError(null);
    startTransition(async () => {
      let res: { ok: boolean; message?: string };
      try {
        res = await action();
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) done?.();
      else setError(res.message ?? "failed");
    });
  };

  let next: React.ReactNode;
  if (contact.doNotContact) {
    next = <span className="text-faint">Do not contact — nothing is scheduled.</span>;
  } else if (contact.nextFollowUpAt && dueKind) {
    const when = dueWhen(contact.nextFollowUpAt, nowMs, timeZone);
    next = (
      <span className={when.overdue ? "text-bad" : "text-ink"} data-testid="next-due">
        Next: {DUE_LABELS[dueKind]}, {when.text}
        {contact.followUpOverrideAt && <span className="text-faint"> (snoozed)</span>}
        {canDraft && (
          <button type="button" onClick={onDraft} className="ml-3 text-[12px] text-accent hover:underline">
            {DRAFT_LABELS[dueKind]}
          </button>
        )}
      </span>
    );
  } else if (contact.status === "PENDING_CONNECTION" && contact.pendingSince) {
    next = (
      <span className="text-dim" data-testid="next-due">
        Connection request pending {relativeAge(contact.pendingSince, nowMs)}. Mark connected once they accept.
      </span>
    );
  } else if (contact.status === "COLD") {
    next = (
      <span className="text-faint">
        Gone cold —{" "}
        {contact.followUpsSent === 0
          ? "no reply to the opener."
          : `no reply after ${contact.followUpsSent} follow-up${contact.followUpsSent === 1 ? "" : "s"}.`}
      </span>
    );
  } else {
    next = <span className="text-faint">Nothing due.</span>;
  }

  const BTN = "rounded border border-line px-2.5 py-1 text-[12px] text-dim hover:text-ink disabled:opacity-60";

  return (
    <section aria-label="Follow-up" className="flex flex-col gap-2 rounded border border-line bg-panel px-3 py-2">
      <div className="text-[13px]">{next}</div>
      <div className="flex flex-wrap items-center gap-2">
        {contact.status === "PENDING_CONNECTION" && (
          <button
            type="button"
            className={BTN}
            disabled={pending}
            onClick={() =>
              run(() =>
                logMessageAction({
                  contactId: contact.id,
                  message: {
                    direction: "IN",
                    type: "ACCEPTED",
                    channel: "LINKEDIN",
                    body: "",
                    sentAt: new Date().toISOString(),
                  },
                }),
              )
            }
          >
            Mark connected
          </button>
        )}
        <button type="button" className={BTN} disabled={pending} onClick={onLogMeeting}>
          Log meeting
        </button>

        <label className="flex items-center gap-1 text-[12px] text-dim">
          Status
          <select
            aria-label="Set status by hand"
            value={contact.manualStatus ?? ""}
            disabled={pending}
            onChange={(e) =>
              run(() =>
                setManualStatusAction({
                  contactId: contact.id,
                  status: (e.target.value || null) as "CHATTED" | "REFERRED" | null,
                }),
              )
            }
            className="h-7 rounded border border-line bg-raised px-1 text-[12px]"
            title="Set CHATTED or REFERRED by hand. A newer opener takes over again."
          >
            <option value="">automatic</option>
            <option value="CHATTED">chatted</option>
            <option value="REFERRED">referred</option>
          </select>
        </label>

        <span className="flex items-center gap-1 text-[12px] text-dim">
          Snooze to
          <input
            type="date"
            aria-label="Snooze until"
            min={todayIn(timeZone, nowMs)}
            value={snoozeDate}
            onChange={(e) => setSnoozeDate(e.target.value)}
            className="h-7 rounded border border-line bg-raised px-1 font-mono text-[12px]"
          />
          <button
            type="button"
            className={BTN}
            disabled={pending || snoozeDate === ""}
            onClick={() => run(() => snoozeAction({ contactId: contact.id, until: snoozeDate }), () => setSnoozeDate(""))}
          >
            Snooze
          </button>
          {contact.followUpOverrideAt && (
            <button
              type="button"
              className={BTN}
              disabled={pending}
              onClick={() => run(() => snoozeAction({ contactId: contact.id, until: null }))}
            >
              Clear snooze
            </button>
          )}
        </span>
      </div>
      {error && (
        <p role="alert" className="text-[12px] text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
