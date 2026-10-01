"use client";

import { useState, useTransition } from "react";
import type { CompanyListingOption } from "@/lib/networking/messages";
import { DRAFT_TYPE_LABELS, DRAFT_TYPES, draftUsesSubject, type DraftType } from "@/lib/networking/draft";
import { CHANNEL_LABELS } from "@/lib/networking/schema";
import type { OutreachChannel } from "@/generated/prisma/enums";
import { draftMessageAction, logMessageAction } from "../actions";
import {
  buildMailto,
  defaultDraftChannel,
  draftChannels,
  emptyEditor,
  lengthNote,
  markSentPayload,
  type DraftEditor,
} from "../draft-state";

/**
 * Draft → edit → send yourself → Mark sent.
 *
 * Claude writes the first version; you edit it HERE (that's what later drafts
 * learn your voice from); "Open in mail" or "Copy" hands it to your own mail
 * client or LinkedIn; "Mark sent" logs it — only then does anything get saved.
 * The draft is shown in a textarea, never rendered as markup.
 */

export interface DraftAvailability {
  /** Claude connected (token configured) — false shows why instead of a button. */
  connected: boolean;
  reason: string | null;
}

interface Props {
  contactId: string;
  contactName: string;
  email: string | null;
  doNotContact: boolean;
  listings: CompanyListingOption[];
  availability: DraftAvailability;
  initialType: DraftType;
  initialListingId: string | null;
  /** Default the channel to LinkedIn (after an accepted connection, or no email). */
  preferLinkedIn: boolean;
  onClose: () => void;
}

const INPUT = "h-7 w-full rounded border border-line bg-raised px-2 text-[13px]";
const BTN = "rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink disabled:opacity-60";
const PRIMARY = "rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60";

export default function DraftPanel({
  contactId,
  contactName,
  email,
  doNotContact,
  listings,
  availability,
  initialType,
  initialListingId,
  preferLinkedIn,
  onClose,
}: Props) {
  const [e, setE] = useState<DraftEditor>(() =>
    emptyEditor(initialType, defaultDraftChannel(initialType, preferLinkedIn), initialListingId ?? ""),
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [drafting, startDraft] = useTransition();
  const [saving, startSave] = useTransition();
  const set = <K extends keyof DraftEditor>(k: K, v: DraftEditor[K]) => setE((s) => ({ ...s, [k]: v }));

  const canDraft = availability.connected && !doNotContact;
  const hasText = e.body.trim() !== "";
  const mailto = e.channel === "EMAIL" ? buildMailto(email, e.subject, e.body) : null;
  const len = lengthNote(e.type, e.body);

  const onDraft = () => {
    setError(null);
    setCopied(false);
    startDraft(async () => {
      let res: Awaited<ReturnType<typeof draftMessageAction>>;
      try {
        res = await draftMessageAction({
          contactId,
          type: e.type,
          listingId: e.listingId || null,
          nudge: e.nudge || null,
        });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        setE((s) => ({ ...s, subject: res.subject ?? "", body: res.body, draftBody: res.body, warning: res.warning }));
      } else {
        setError(res.message);
      }
    });
  };

  const onCopy = async () => {
    const text = draftUsesSubject(e.type) && e.channel === "EMAIL" && e.subject ? `${e.subject}\n\n${e.body}` : e.body;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("Couldn't copy — select the text and copy it by hand.");
    }
  };

  const onMarkSent = () => {
    setError(null);
    startSave(async () => {
      let res: Awaited<ReturnType<typeof logMessageAction>>;
      try {
        res = await logMessageAction({ contactId, message: markSentPayload(e, new Date()) });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) onClose();
      else setError(res.message);
    });
  };

  return (
    <section aria-label="Draft" className="flex flex-col gap-3 rounded border border-line bg-panel px-3 py-3" data-testid="draft-panel">
      <div className="flex items-baseline gap-2">
        <h2 className="text-[13px] font-medium">Draft a message to {contactName}</h2>
        <button type="button" onClick={onClose} className="ml-auto text-[12px] text-faint hover:text-ink">
          close
        </button>
      </div>

      <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Type</span>
          <select
            value={e.type}
            onChange={(ev) => {
              const type = ev.target.value as DraftType;
              setE((s) => ({
                ...s,
                type,
                channel: draftChannels(type).includes(s.channel) ? s.channel : draftChannels(type)[0],
                // A draft of another type isn't this message's draft: kept, it
                // would teach e.g. follow-ups from a cold email's text.
                draftBody: null,
                warning: null,
              }));
            }}
            className={INPUT}
          >
            {DRAFT_TYPES.map((t) => (
              <option key={t} value={t}>
                {DRAFT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] text-dim">Sending by</span>
          <select
            value={e.channel}
            onChange={(ev) => set("channel", ev.target.value as OutreachChannel)}
            disabled={draftChannels(e.type).length === 1}
            className={INPUT}
          >
            {draftChannels(e.type).map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        {listings.length > 0 && (
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="text-[12px] text-dim">About a role (optional)</span>
            <select value={e.listingId} onChange={(ev) => set("listingId", ev.target.value)} className={INPUT}>
              <option value="">— none —</option>
              {listings.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1 sm:col-span-2 lg:col-span-4">
          <span className="text-[12px] text-dim">Nudge (optional)</span>
          <input
            value={e.nudge}
            maxLength={300}
            onChange={(ev) => set("nudge", ev.target.value)}
            placeholder="e.g. mention I use their API in my project"
            className={INPUT}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {canDraft ? (
          <button type="button" onClick={onDraft} disabled={drafting} className={PRIMARY}>
            {drafting ? "Drafting…" : e.draftBody ? "Regenerate" : "Draft"}
          </button>
        ) : (
          <span className="text-[12px] text-warn" data-testid="draft-unavailable">
            {doNotContact ? `${contactName} is marked do-not-contact — drafting is off.` : availability.reason}
          </span>
        )}
        <span className="text-[11px] text-faint" data-testid="draft-disclosure">
          Drafting sends to Anthropic, through your Claude account: this contact&apos;s name, title, company, how you
          met and your notes on them; your recent messages with them (including their replies); the role&apos;s
          posting text, if you picked one; your resume; your voice notes; and a few of your past edited messages.
        </span>
      </div>

      {(hasText || e.draftBody) && (
        <div className="flex flex-col gap-2">
          <p className="text-[11px] text-faint">Edit here before sending — this is how drafts learn your voice.</p>
          {draftUsesSubject(e.type) && e.channel === "EMAIL" && (
            <input
              aria-label="Subject"
              value={e.subject}
              maxLength={300}
              onChange={(ev) => set("subject", ev.target.value)}
              className={INPUT}
            />
          )}
          <textarea
            aria-label="Message"
            value={e.body}
            maxLength={20_000}
            rows={10}
            onChange={(ev) => set("body", ev.target.value)}
            className="w-full rounded border border-line bg-raised px-2 py-1 text-[13px] leading-snug"
          />
          <div className="flex flex-wrap items-center gap-2">
            {len && (
              <span className={`font-mono text-[11px] ${len.over ? "text-bad" : "text-faint"}`} data-testid="length">
                {len.text}
              </span>
            )}
            {e.warning && <span className="text-[12px] text-warn">{e.warning}</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {e.channel === "EMAIL" &&
              (mailto ? (
                <a href={mailto} className={BTN} data-testid="mailto">
                  Open in mail
                </a>
              ) : (
                <span className="text-[11px] text-faint">
                  {email ? "Too long for a mail link — use Copy." : "No email on file — use Copy."}
                </span>
              ))}
            <button type="button" onClick={onCopy} disabled={!hasText} className={BTN}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={onMarkSent} disabled={!hasText || saving} className={PRIMARY}>
              {saving ? "Saving…" : "Mark sent"}
            </button>
            <span className="text-[11px] text-faint">Nothing is logged until you click Mark sent.</span>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="text-[12px] text-bad">
          {error}
        </p>
      )}
    </section>
  );
}
