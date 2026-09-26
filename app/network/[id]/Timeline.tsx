"use client";

import { useState, useTransition } from "react";
import Badge from "@/components/Badge";
import type { TimelineMessage } from "@/lib/networking/messages";
import { CHANNEL_LABELS, eventLabel, MESSAGE_LIMITS } from "@/lib/networking/schema";
import { deleteMessageAction, editMessageAction } from "../actions";
import { showsSubject, toLocalInput } from "../state";

/**
 * Every logged message, newest first. A message's words and date can be
 * edited, or it can be deleted; its kind can't be changed (delete and re-log
 * instead), because the kind is what the follow-up engine reasons about.
 * Bodies are rendered as text with their line breaks, never as markup.
 */

interface Props {
  messages: TimelineMessage[];
  timeZone: string;
}

function formatWhen(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export default function Timeline({ messages, timeZone }: Props) {
  if (messages.length === 0) {
    return <p className="px-3 py-3 text-[12px] text-faint">Nothing logged yet.</p>;
  }
  return (
    <ol className="divide-y divide-line-soft" data-testid="timeline">
      {messages.map((m) => (
        <TimelineItem key={m.id} m={m} timeZone={timeZone} />
      ))}
    </ol>
  );
}

function TimelineItem({ m, timeZone }: { m: TimelineMessage; timeZone: string }) {
  const [editing, setEditing] = useState<{ subject: string; body: string; sentAtLocal: string } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<{ ok: boolean; message?: string }>, done: () => void) => {
    setError(null);
    startTransition(async () => {
      let res: { ok: boolean; message?: string };
      try {
        res = await action();
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) done();
      else setError(res.message ?? "failed");
    });
  };

  const onSave = () => {
    if (!editing) return;
    const sentAt = new Date(editing.sentAtLocal);
    if (Number.isNaN(sentAt.getTime())) return setError("pick when it happened");
    run(
      () =>
        editMessageAction({
          messageId: m.id,
          edit: { subject: editing.subject, body: editing.body, sentAt: sentAt.toISOString() },
        }),
      () => setEditing(null),
    );
  };

  return (
    <li className="px-3 py-2" data-testid="timeline-item" data-direction={m.direction}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px]">
        <span className={m.direction === "IN" ? "text-info" : "text-ink"}>
          {m.direction === "IN" ? "←" : "→"} {eventLabel(m.direction, m.type)}
        </span>
        <span className="text-faint">{CHANNEL_LABELS[m.channel]}</span>
        <time dateTime={m.sentAt} className="font-mono text-faint tabular-nums">
          {formatWhen(m.sentAt, timeZone)}
        </time>
        {m.listing && (
          <span className="min-w-0 truncate text-dim" title={m.listing.title}>
            re: {m.listing.title}
          </span>
        )}
        {m.drafted && (
          <Badge tone="dim" title="Started from a Claude draft">
            drafted
          </Badge>
        )}
        {!editing && !confirming && (
          <span className="ml-auto flex gap-2">
            <button
              type="button"
              className="text-faint hover:text-ink"
              onClick={() =>
                setEditing({ subject: m.subject ?? "", body: m.body, sentAtLocal: toLocalInput(new Date(m.sentAt)) })
              }
            >
              edit
            </button>
            <button type="button" className="text-faint hover:text-bad" onClick={() => setConfirming(true)}>
              delete
            </button>
          </span>
        )}
      </div>

      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <input
            type="datetime-local"
            aria-label="When"
            value={editing.sentAtLocal}
            onChange={(e) => setEditing({ ...editing, sentAtLocal: e.target.value })}
            className="h-7 w-56 rounded border border-line bg-raised px-2 font-mono text-[13px]"
          />
          {showsSubject(m.channel) && (
            <input
              aria-label="Subject"
              value={editing.subject}
              maxLength={MESSAGE_LIMITS.subject}
              onChange={(e) => setEditing({ ...editing, subject: e.target.value })}
              className="h-7 rounded border border-line bg-raised px-2 text-[13px]"
            />
          )}
          <textarea
            aria-label="Message"
            value={editing.body}
            maxLength={MESSAGE_LIMITS.body}
            rows={5}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
            className="rounded border border-line bg-raised px-2 py-1 text-[13px] leading-snug"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={pending}
              className="rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => setEditing(null)}
              disabled={pending}
              className="rounded border border-line px-3 py-1 text-[12px] text-dim"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          {m.subject && <p className="mt-1 text-[13px] font-medium">{m.subject}</p>}
          {m.body && <p className="mt-1 text-[13px] leading-snug whitespace-pre-wrap text-dim">{m.body}</p>}
        </>
      )}

      {confirming && (
        <div className="mt-2 flex items-center gap-2 text-[12px]">
          <span className="text-bad">Delete this message? Follow-up dates are recomputed without it.</span>
          <button
            type="button"
            disabled={pending}
            onClick={() => run(() => deleteMessageAction({ messageId: m.id }), () => setConfirming(false))}
            className="rounded border border-bad px-2 py-0.5 text-bad"
          >
            {pending ? "Deleting…" : "Delete"}
          </button>
          <button type="button" onClick={() => setConfirming(false)} className="rounded border border-line px-2 py-0.5 text-dim">
            Keep
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-[12px] text-bad">
          {error}
        </p>
      )}
    </li>
  );
}
