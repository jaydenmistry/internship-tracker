"use client";

import { useState, useTransition } from "react";
import Badge from "@/components/Badge";
import type { AlertKind } from "@/lib/alerts/types";
import type { AlertSettings } from "@/lib/alerts/settings";
import type { RecentAlert } from "@/lib/alerts/data";
import { saveAlertSettingsAction, sendAlertNowAction, type AlertsActionResult } from "./actions";
import {
  CHANNEL_LABELS,
  fromForm,
  KIND_BLURBS,
  KIND_LABELS,
  KINDS,
  NUMBER_FIELDS,
  TOGGLE_FIELDS,
  toForm,
  type SettingsForm,
} from "./state";

/**
 * /alerts — thresholds, a manual trigger per alert kind, and the log of what
 * actually went out.
 *
 * Every string from the database (company, role, dedupe key) is rendered as
 * text, never as markup: these come from scraped postings.
 */

export interface ChannelStatus {
  channel: "DISCORD" | "EMAIL";
  ready: boolean;
  reason: string;
}

interface Props {
  settings: AlertSettings;
  recent: RecentAlert[];
  channels: ChannelStatus[];
}

type Notice = { tone: "ok" | "bad"; text: string } | null;

export default function AlertsView({ settings, recent, channels }: Props) {
  const [form, setForm] = useState<SettingsForm>(() => toForm(settings));
  const [saveNotice, setSaveNotice] = useState<Notice>(null);
  const [sendNotice, setSendNotice] = useState<Notice>(null);
  const [busyKind, setBusyKind] = useState<AlertKind | null>(null);
  const [pending, startTransition] = useTransition();

  const apply = (result: AlertsActionResult, set: (n: Notice) => void) => {
    set({ tone: result.ok ? "ok" : "bad", text: result.message });
  };

  const onSave = () => {
    const payload = fromForm(form);
    if (!payload.ok) {
      setSaveNotice({ tone: "bad", text: payload.message });
      return;
    }
    setSaveNotice(null);
    startTransition(async () => {
      apply(await saveAlertSettingsAction(payload.value), setSaveNotice);
    });
  };

  const onSend = (kind: AlertKind) => {
    setSendNotice(null);
    setBusyKind(kind);
    startTransition(async () => {
      const result = await sendAlertNowAction({ kind });
      setBusyKind(null);
      apply(result, setSendNotice);
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <section className="rounded border border-line bg-panel">
        <Header
          title="Channels"
          note="Webhook URL and SMTP credentials come from the environment — they are never stored in the database or shown here."
        />
        <div className="flex flex-wrap gap-4 px-3 py-3">
          {channels.map((c) => (
            <div key={c.channel} className="flex items-center gap-2">
              <span className="text-[13px]">{CHANNEL_LABELS[c.channel]}</span>
              <Badge tone={c.ready ? "ok" : "warn"} title={c.reason}>
                {c.ready ? "ready" : "off"}
              </Badge>
              <span className="text-[12px] text-faint">{c.reason}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="rounded border border-line bg-panel">
        <Header title="Thresholds" note="Read fresh on every run — the worker picks these up without a restart." />
        <div className="grid gap-x-6 gap-y-3 px-3 py-3 sm:grid-cols-2 lg:grid-cols-3">
          {NUMBER_FIELDS.map((field) => (
            <label key={field.key} className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">
                {field.label}
                {field.unit && <span className="text-faint"> ({field.unit})</span>}
              </span>
              <input
                type="number"
                inputMode="numeric"
                min={field.min}
                max={field.max}
                step={1}
                value={form[field.key]}
                onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
                className="h-7 w-24 rounded border border-line bg-raised px-2 font-mono text-[13px] tabular-nums"
              />
              <span className="text-[11px] leading-snug text-faint">{field.hint}</span>
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t border-line-soft px-3 py-3">
          {TOGGLE_FIELDS.map((toggle) => (
            <label key={toggle.key} className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={form[toggle.key]}
                onChange={(e) => setForm((f) => ({ ...f, [toggle.key]: e.target.checked }))}
                className="size-3.5 accent-[var(--accent)]"
              />
              Send to {CHANNEL_LABELS[toggle.channel]}
            </label>
          ))}
          <button
            type="button"
            onClick={onSave}
            disabled={pending}
            className="ml-auto rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60"
          >
            {pending && busyKind === null ? "Saving…" : "Save thresholds"}
          </button>
          <NoticeLine notice={saveNotice} />
        </div>
      </section>

      <section className="rounded border border-line bg-panel">
        <Header
          title="Send now"
          note="Runs the same code path as cron. Anything the alert log already covers is skipped and reported, not re-sent."
        />
        <div className="grid gap-3 px-3 py-3 sm:grid-cols-3">
          {KINDS.map((kind) => (
            <div key={kind} className="flex flex-col gap-2 rounded border border-line-soft bg-raised px-3 py-2">
              <span className="text-[13px]">{KIND_LABELS[kind]}</span>
              <span className="text-[11px] leading-snug text-faint">{KIND_BLURBS[kind]}</span>
              <button
                type="button"
                onClick={() => onSend(kind)}
                disabled={pending}
                className="mt-auto self-start rounded border border-line bg-panel px-2 py-1 text-[12px] text-dim hover:border-faint hover:text-ink disabled:opacity-60"
              >
                {busyKind === kind ? "Sending…" : "Send now"}
              </button>
            </div>
          ))}
        </div>
        <div className="border-t border-line-soft px-3 py-2">
          <NoticeLine notice={sendNotice} placeholder="No manual send this session." />
        </div>
      </section>

      <section className="rounded border border-line bg-panel">
        <Header title="Recent alerts" note={`Last ${recent.length} deliveries recorded in the alert log.`} />
        {recent.length === 0 ? (
          <p className="px-3 py-3 text-[12px] text-faint">
            Nothing sent yet. An alert is logged only after the channel accepted it, so an empty log
            means nothing was delivered.
          </p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {recent.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline gap-2 px-3 py-1.5 text-[12px]">
                <time dateTime={row.sentAt} className="w-32 shrink-0 font-mono text-faint tabular-nums">
                  {row.sentAtLabel}
                </time>
                <Badge tone="info">{KIND_LABELS[row.kind]}</Badge>
                <Badge tone="dim">{CHANNEL_LABELS[row.channel]}</Badge>
                <span className="min-w-0 truncate">
                  {row.company ? `${row.company} — ${row.title ?? ""}` : "—"}
                </span>
                <span className="ml-auto truncate font-mono text-[10px] text-faint" title={row.dedupeKey}>
                  {row.dedupeKey}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Header({ title, note }: { title: string; note: string }) {
  return (
    <div className="border-b border-line-soft px-3 py-2">
      <h2 className="text-[13px] font-semibold">{title}</h2>
      <p className="text-[11px] text-faint">{note}</p>
    </div>
  );
}

function NoticeLine({ notice, placeholder }: { notice: Notice; placeholder?: string }) {
  if (!notice) {
    return placeholder ? <p className="text-[12px] text-faint">{placeholder}</p> : null;
  }
  return (
    <p role="status" className={`text-[12px] ${notice.tone === "ok" ? "text-ok" : "text-bad"}`}>
      {notice.text}
    </p>
  );
}
