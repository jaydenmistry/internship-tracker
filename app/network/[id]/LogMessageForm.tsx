"use client";

import { CHANNEL_LABELS, MESSAGE_LIMITS } from "@/lib/networking/schema";
import type { CompanyListingOption } from "@/lib/networking/messages";
import type { OutreachChannel } from "@/generated/prisma/enums";
import {
  channelsFor,
  EVENT_OPTIONS,
  showsSubject,
  withEvent,
  type MessageForm,
} from "../state";

/**
 * "Log message": record something that already happened — you sent it (by
 * mail or LinkedIn, outside this app) or they replied. The event picker only
 * offers real events, and the channel list narrows to what that event allows,
 * matching the server's MESSAGE_RULES.
 */

interface Props {
  form: MessageForm;
  onChange: (f: MessageForm) => void;
  onSubmit: () => void;
  onCancel: () => void;
  listings: CompanyListingOption[];
  pending: boolean;
  error: string | null;
}

const INPUT = "h-7 w-full rounded border border-line bg-raised px-2 text-[13px]";
const LABEL = "flex min-w-0 flex-col gap-1";
const CAPTION = "text-[12px] text-dim";

export default function LogMessageForm({ form, onChange, onSubmit, onCancel, listings, pending, error }: Props) {
  const opt = EVENT_OPTIONS.find((o) => o.value === form.event) ?? EVENT_OPTIONS[0];
  const channels = channelsFor(opt.direction, opt.type);
  const set = <K extends keyof MessageForm>(key: K, value: MessageForm[K]) => onChange({ ...form, [key]: value });
  const bodyLabel =
    opt.type === "MEETING" ? "What you talked about" : opt.direction === "IN" ? "What they said" : "What you sent";

  return (
    <form
      aria-label="Log message"
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className={`${LABEL} sm:col-span-2`}>
          <span className={CAPTION}>What happened</span>
          <select value={form.event} onChange={(e) => onChange(withEvent(form, e.target.value))} className={INPUT}>
            {EVENT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Channel</span>
          <select
            value={form.channel}
            onChange={(e) => set("channel", e.target.value as OutreachChannel)}
            disabled={channels.length === 1}
            className={INPUT}
          >
            {channels.map((c) => (
              <option key={c} value={c}>
                {CHANNEL_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>When</span>
          <input
            type="datetime-local"
            required
            value={form.sentAtLocal}
            onChange={(e) => set("sentAtLocal", e.target.value)}
            className={`${INPUT} font-mono`}
          />
        </label>
        {showsSubject(form.channel) && (
          <label className={`${LABEL} sm:col-span-2`}>
            <span className={CAPTION}>Subject</span>
            <input
              value={form.subject}
              maxLength={MESSAGE_LIMITS.subject}
              onChange={(e) => set("subject", e.target.value)}
              className={INPUT}
            />
          </label>
        )}
        {listings.length > 0 && (
          <label className={`${LABEL} sm:col-span-2`}>
            <span className={CAPTION}>About a role (optional)</span>
            <select value={form.listingId} onChange={(e) => set("listingId", e.target.value)} className={INPUT}>
              <option value="">— none —</option>
              {listings.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className={`${LABEL} sm:col-span-2 lg:col-span-4`}>
          <span className={CAPTION}>{bodyLabel}</span>
          <textarea
            value={form.body}
            maxLength={MESSAGE_LIMITS.body}
            onChange={(e) => set("body", e.target.value)}
            rows={5}
            placeholder={opt.type === "ACCEPTED" ? "Optional" : "Paste the message, or a few words about it"}
            className="w-full rounded border border-line bg-raised px-2 py-1 text-[13px] leading-snug"
          />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60"
        >
          {pending ? "Saving…" : "Log it"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink"
        >
          Cancel
        </button>
        {error && (
          <p role="alert" className="text-[12px] text-bad">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
