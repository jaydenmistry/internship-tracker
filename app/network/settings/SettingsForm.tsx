"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { VOICE_NOTES_MAX, type NetworkingSettings } from "@/lib/networking/settings";
import { saveNetworkingSettingsAction } from "../actions";

/**
 * /network/settings — the follow-up cadence and your voice notes. Saving the
 * cadence recomputes every contact's due date on the server.
 */

type NumberKey = "firstFollowUpBusinessDays" | "secondFollowUpBusinessDays" | "maxFollowUps" | "voiceExampleCount";

const FIELDS: Array<{ key: NumberKey; label: string; min: number; max: number; hint: string }> = [
  {
    key: "firstFollowUpBusinessDays",
    label: "First follow-up after",
    min: 1,
    max: 30,
    hint: "Business days after an opener (cold email, LinkedIn message, referral ask).",
  },
  {
    key: "secondFollowUpBusinessDays",
    label: "Each later follow-up after",
    min: 1,
    max: 30,
    hint: "Business days after the previous follow-up — and, after the last one, until the contact goes cold.",
  },
  { key: "maxFollowUps", label: "Follow-ups before cold", min: 0, max: 5, hint: "0 = never remind, just go cold." },
  {
    key: "voiceExampleCount",
    label: "Voice examples per draft",
    min: 0,
    max: 10,
    hint: "How many of your edited past messages of the same type a draft learns from.",
  },
];

export default function SettingsForm({
  settings,
  claude,
}: {
  settings: NetworkingSettings;
  /** Only whether a token is configured and which model — never the token. */
  claude: { connected: boolean; model: string };
}) {
  const [form, setForm] = useState<Record<NumberKey, string> & { voiceNotes: string }>(() => ({
    firstFollowUpBusinessDays: String(settings.firstFollowUpBusinessDays),
    secondFollowUpBusinessDays: String(settings.secondFollowUpBusinessDays),
    maxFollowUps: String(settings.maxFollowUps),
    voiceExampleCount: String(settings.voiceExampleCount),
    voiceNotes: settings.voiceNotes,
  }));
  const [notice, setNotice] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    const payload: Record<string, unknown> = { voiceNotes: form.voiceNotes };
    for (const f of FIELDS) {
      const n = Number(form[f.key]);
      if (!Number.isInteger(n) || n < f.min || n > f.max) {
        return setNotice({ tone: "bad", text: `${f.label}: a whole number from ${f.min} to ${f.max}` });
      }
      payload[f.key] = n;
    }
    setNotice(null);
    startTransition(async () => {
      let res: { ok: boolean; message?: string };
      try {
        res = await saveNetworkingSettingsAction(payload);
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      setNotice(
        res.ok ? { tone: "ok", text: "Saved. Every contact's due date was recomputed." } : { tone: "bad", text: res.message ?? "failed" },
      );
    });
  };

  return (
    <div className="flex max-w-4xl flex-col gap-3">
      <nav className="text-[12px] text-dim">
        <Link href="/network" className="hover:text-ink">
          ← Network
        </Link>
      </nav>
      <section className="rounded border border-line bg-panel" aria-label="Claude connection" data-testid="claude-status">
        <h2 className="border-b border-line px-3 py-1.5 text-[13px] font-medium">Claude (drafting)</h2>
        <div className="flex flex-col gap-1 px-3 py-2 text-[12px]">
          {claude.connected ? (
            <p>
              <span className="text-ok">Connected</span>
              <span className="text-dim">
                {" "}
                — drafts use your Claude subscription ({claude.model}). A token that has expired or been revoked shows up
                as an error when you click Draft.
              </span>
            </p>
          ) : (
            <p className="text-warn">
              Claude not connected. Run <code className="font-mono">claude setup-token</code> on a machine with a
              browser, and set the token it prints as <code className="font-mono">CLAUDE_CODE_OAUTH_TOKEN</code> for
              the app (host .env: <code className="font-mono">TRACKER_CLAUDE_CODE_OAUTH_TOKEN</code>), then restart.
              Hand-written messages keep working.
            </p>
          )}
          <p className="text-faint">
            Drafts go through your personal Claude account, so your claude.ai privacy settings apply — check that model
            training is off, since drafts include other people&apos;s names and your notes on them. Drafting counts
            against your plan&apos;s usage limits.
          </p>
        </div>
      </section>
      <section className="rounded border border-line bg-panel">
        <h2 className="border-b border-line px-3 py-1.5 text-[13px] font-medium">Follow-up cadence</h2>
        <div className="grid gap-x-6 gap-y-3 px-3 py-3 sm:grid-cols-2">
          {FIELDS.map((f) => (
            <label key={f.key} className="flex flex-col gap-1">
              <span className="text-[12px] text-dim">{f.label}</span>
              <input
                type="number"
                inputMode="numeric"
                min={f.min}
                max={f.max}
                step={1}
                value={form[f.key]}
                onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                className="h-7 w-24 rounded border border-line bg-raised px-2 font-mono text-[13px] tabular-nums"
              />
              <span className="text-[11px] leading-snug text-faint">{f.hint}</span>
            </label>
          ))}
        </div>
      </section>
      <section className="rounded border border-line bg-panel">
        <h2 className="border-b border-line px-3 py-1.5 text-[13px] font-medium">Your voice</h2>
        <label className="flex flex-col gap-1 px-3 py-3">
          <span className="text-[12px] text-dim">
            How you write, in your own words. Every draft includes this.
          </span>
          <textarea
            value={form.voiceNotes}
            maxLength={VOICE_NOTES_MAX}
            rows={6}
            onChange={(e) => setForm((s) => ({ ...s, voiceNotes: e.target.value }))}
            placeholder="No em dashes. Plain verbs, first person. Specific over general. Lead with the strongest point."
            className="rounded border border-line bg-raised px-2 py-1 text-[13px] leading-snug"
          />
          <span className="text-right font-mono text-[11px] text-faint tabular-nums">
            {form.voiceNotes.length} / {VOICE_NOTES_MAX}
          </span>
        </label>
      </section>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          className="rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60"
        >
          {pending ? "Saving…" : "Save"}
        </button>
        {notice && (
          <p role={notice.tone === "bad" ? "alert" : "status"} className={`text-[12px] ${notice.tone === "ok" ? "text-ok" : "text-bad"}`}>
            {notice.text}
          </p>
        )}
      </div>
    </div>
  );
}
