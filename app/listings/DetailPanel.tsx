"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import Badge from "@/components/Badge";
import type { ComponentDetail, ListingDetail, ResumeMatchState } from "@/lib/listings/detail";
import { NOTES_MAX, type RowCommand, type SendResult } from "./row-actions";
import {
  absoluteDate,
  absoluteDay,
  deadlineUrgency,
  dqBadge,
  formatDeadline,
  formatScore,
  rankMovement,
  safeHttpUrl,
  STATUS_FILTER_LABELS,
  STATUS_ORDER,
  type TableRow,
} from "./table-state";

/**
 * The listing detail panel.
 *
 * Rendering rule for this whole file: every string that reaches the DOM —
 * evidence (raw scraped substrings), the model's rationale, the user's notes,
 * company/role/location — is a React text child. No innerHTML, no markdown.
 * The only attributes carrying listing data are hrefs, and those go through
 * `safeHttpUrl` (http/https only) first.
 *
 * Status, save and dismiss come from the TABLE row (which carries the
 * optimistic overlay) and are changed through the same `onCommand` the
 * keyboard and the context menu use.
 */

export type DetailLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "missing" }
  | { status: "ready"; detail: ListingDetail; refreshing: boolean };

interface Props {
  row: TableRow;
  load: DetailLoadState;
  now: number;
  onCommand: (command: RowCommand) => void;
  onSaveNotes: (listingId: string, notes: string) => Promise<SendResult>;
  onRetry: () => void;
  onClose: () => void;
}

export default function DetailPanel({
  row,
  load,
  now,
  onCommand,
  onSaveNotes,
  onRetry,
  onClose,
}: Props) {
  const detail = load.status === "ready" ? load.detail : null;
  const href = safeHttpUrl(detail?.url ?? row.url);

  return (
    <aside
      aria-label="Listing detail"
      data-detail-panel=""
      className="dp-panel flex w-[27rem] shrink-0 flex-col overflow-y-auto border-l border-line bg-panel"
    >
      <header className="sticky top-0 z-10 flex items-start gap-2 border-b border-line bg-panel px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1 text-[13px] font-medium text-ink">
            {row.faangPlus && (
              <span className="text-warn" title="FAANG+ company">
                ★
              </span>
            )}
            <span className="truncate" title={row.company}>
              {row.company}
            </span>
          </div>
          <div className="text-[12px] leading-snug text-dim">{row.title}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail panel"
          className="shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] text-faint hover:bg-raised hover:text-ink"
        >
          esc
        </button>
      </header>

      <div className="space-y-4 px-3 py-3">
        <Summary row={row} detail={detail} href={href} />

        <StatusControls row={row} onCommand={onCommand} />

        {load.status === "loading" && (
          <p className="text-[12px] text-faint" role="status">
            Loading details…
          </p>
        )}
        {load.status === "missing" && (
          <p className="text-[12px] text-bad">This listing no longer exists.</p>
        )}
        {load.status === "error" && (
          <div className="rounded border border-bad/50 px-2 py-1.5 text-[12px] text-bad" role="alert">
            <p>Couldn&apos;t load the details: {load.message}</p>
            <button
              type="button"
              onClick={onRetry}
              className="mt-1 rounded border border-line px-1.5 py-0.5 text-dim hover:text-ink"
            >
              Retry
            </button>
          </div>
        )}

        {detail && (
          <>
            <Facts detail={detail} now={now} />
            {detail.disqualified && <Disqualified detail={detail} />}
            <Breakdown detail={detail} />
            <LlmSection detail={detail} />
            <FetchSection detail={detail} />
            <ResumeSection match={detail.resumeMatch} />
            <Notes
              key={detail.id}
              listingId={detail.id}
              initial={detail.application?.notes ?? ""}
              onSave={onSaveNotes}
            />
            <Timeline detail={detail} />
          </>
        )}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="border-t border-line-soft pt-3" aria-label={title}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
          {title}
        </h3>
        {aside && <div className="ml-auto text-[11px] text-faint">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

function Summary({
  row,
  detail,
  href,
}: {
  row: TableRow;
  detail: ListingDetail | null;
  href: string | null;
}) {
  const movement = rankMovement(row.rankDelta);
  const llm = detail ? detail.llmAdjustment : row.llmAdjustment;
  const rule = detail?.ruleScore ?? null;

  return (
    <div className="space-y-2.5">
      <div className="flex items-end gap-3">
        <div>
          <div
            className={`font-mono text-[28px] leading-none tabular-nums ${
              row.disqualified ? "text-faint line-through" : "text-ink"
            }`}
            title="Final score (0–100)"
          >
            {formatScore(row.score)}
          </div>
          <div className="mt-1 font-mono text-[10px] text-faint">
            {rule !== null ? `rules ${formatScore(rule)}` : "rules —"}
            {" · "}
            {llm !== null ? (
              <span className="text-info" title="Stage-2 Claude adjustment, clamped to ±15">
                claude {signed(llm)}
              </span>
            ) : (
              <span title="No stage-2 Claude adjustment applied">claude —</span>
            )}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <span className="font-mono text-[12px] text-dim">
            {row.rank !== null ? `rank #${row.rank}` : "unranked"}
            {movement && (
              <span
                className={`ml-1.5 ${movement.direction === "up" ? "text-ok" : "text-warn"}`}
                title={movement.label}
              >
                {movement.text}
              </span>
            )}
          </span>
          <div className="flex flex-wrap gap-1">
            {row.saved && <Badge tone="accent">saved</Badge>}
            {row.dismissed && <Badge tone="dim">dismissed</Badge>}
            {row.likelyClosed && <Badge tone="dim">closed?</Badge>}
            {row.disqualified && (
              <Badge tone="bad" title={dqBadge(row.disqualifyReasons).title}>
                disqualified
              </Badge>
            )}
          </div>
        </div>
      </div>

      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center rounded border border-accent/60 bg-raised px-2 py-1 text-[12px] text-accent transition-colors hover:border-accent"
        >
          Open the apply link ↗
        </a>
      ) : (
        <p className="text-[12px] text-faint">No usable apply link on this listing.</p>
      )}
    </div>
  );
}

function StatusControls({
  row,
  onCommand,
}: {
  row: TableRow;
  onCommand: (command: RowCommand) => void;
}) {
  return (
    <div className="space-y-1.5" aria-label="Status controls" role="group">
      <div className="flex flex-wrap gap-1">
        {STATUS_ORDER.map((status: AppStatus) => {
          const active = row.statusKey === status;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={active}
              onClick={() => onCommand({ kind: "setStatus", status })}
              className={`rounded border px-1.5 py-[2px] text-[11px] transition-colors ${
                active
                  ? "border-accent bg-accent text-accent-ink"
                  : "border-line text-dim hover:border-faint hover:text-ink"
              }`}
            >
              {STATUS_FILTER_LABELS[status]}
            </button>
          );
        })}
      </div>
      <div className="flex gap-1">
        <button
          type="button"
          aria-pressed={row.saved}
          onClick={() => onCommand({ kind: "toggleSaved" })}
          className="rounded border border-line px-1.5 py-[2px] text-[11px] text-dim hover:border-faint hover:text-ink"
        >
          {row.saved ? "Unsave" : "Save"} <kbd className="ml-1 font-mono text-faint">s</kbd>
        </button>
        <button
          type="button"
          aria-pressed={row.dismissed}
          onClick={() => onCommand({ kind: "toggleDismissed" })}
          className="rounded border border-line px-1.5 py-[2px] text-[11px] text-dim hover:border-faint hover:text-ink"
        >
          {row.dismissed ? "Undismiss" : "Dismiss"} <kbd className="ml-1 font-mono text-faint">d</kbd>
        </button>
      </div>
    </div>
  );
}

function Facts({ detail, now }: { detail: ListingDetail; now: number }) {
  const deadlineTs = detail.deadline ? new Date(detail.deadline).getTime() : null;
  const urgency = deadlineUrgency(deadlineTs, now);
  const locations = detail.remote
    ? ["Remote", ...detail.locations.filter((l) => !/^remote$/i.test(l))]
    : detail.locations;

  const facts: Array<[string, ReactNode]> = [
    ["Locations", locations.length ? locations.join(" · ") : "—"],
    [
      "Deadline",
      deadlineTs !== null ? (
        <span className={urgency === "soon" ? "font-semibold text-warn" : undefined}>
          {absoluteDay(deadlineTs)} ({formatDeadline(deadlineTs, now)})
        </span>
      ) : (
        "—"
      ),
    ],
    ["Posted", detail.postedAt ? absoluteDay(new Date(detail.postedAt).getTime()) : "—"],
    ["First seen", absoluteDay(new Date(detail.firstSeen).getTime())],
    [
      "Sources",
      detail.sources.length
        ? detail.sources
            .map((s) => `${s.source}${s.active ? "" : " (gone)"}`)
            .join(", ")
        : "—",
    ],
  ];
  if (detail.salary) facts.push(["Salary", detail.salary]);
  if (detail.sponsorship) facts.push(["Sponsorship", detail.sponsorship]);
  if (detail.degrees.length) facts.push(["Degrees", detail.degrees.join(", ")]);
  if (detail.terms.length) facts.push(["Terms", detail.terms.join(", ")]);
  if (detail.category) facts.push(["Category", detail.category]);
  if (detail.requisitionId) facts.push(["Req. ID", detail.requisitionId]);

  return (
    <dl className="grid grid-cols-[5.5rem_1fr] gap-x-2 gap-y-1 text-[12px]">
      {facts.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words text-dim">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function Disqualified({ detail }: { detail: ListingDetail }) {
  return (
    <div className="rounded border border-bad/45 px-2.5 py-2 text-[12px]" role="note">
      <p className="font-medium text-bad">
        Disqualified
        {detail.disqualifyReasons.length > 1 ? ` on ${detail.disqualifyReasons.length} grounds` : ""}
      </p>
      {detail.disqualifyReasons.length > 0 ? (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-dim" data-testid="dq-reasons">
          {detail.disqualifyReasons.map((reason, i) => (
            <li key={i}>{reason}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-dim">No reason was recorded.</p>
      )}
      {detail.undisqualifiedScore !== null && (
        <p className="mt-1.5 text-faint">
          Would score {detail.undisqualifiedScore} if it weren&apos;t disqualified.
        </p>
      )}
    </div>
  );
}

const COMPONENT_LABELS: Record<string, string> = {
  techFit: "Tech fit",
  roleType: "Role type",
  companyTier: "Company tier",
  location: "Location",
  freshness: "Freshness",
  deadlineUrgency: "Deadline urgency",
};

function componentLabel(name: string): string {
  return (
    COMPONENT_LABELS[name] ??
    name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (c) => c.toUpperCase())
  );
}

const fmt1 = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

function Breakdown({ detail }: { detail: ListingDetail }) {
  if (detail.components.length === 0) {
    return (
      <Section title="Score breakdown">
        <p className="text-[12px] text-faint">This listing hasn&apos;t been scored yet.</p>
      </Section>
    );
  }
  const total = detail.components.reduce((s, c) => s + c.contribution, 0);
  return (
    <Section
      title="Score breakdown"
      aside={detail.scoredAt ? `scored ${absoluteDate(new Date(detail.scoredAt).getTime())}` : undefined}
    >
      <div className="grid grid-cols-[1fr_3.5rem_2.75rem_3.25rem] gap-x-2 border-b border-line-soft pb-1 font-mono text-[10px] text-faint">
        <span>component</span>
        <span className="text-right">points</span>
        <span className="text-right">weight</span>
        <span className="text-right">adds</span>
      </div>
      <ul className="divide-y divide-line-soft" data-testid="breakdown">
        {detail.components.map((c) => (
          <ComponentRow key={c.name} c={c} />
        ))}
      </ul>
      <div className="grid grid-cols-[1fr_3.5rem_2.75rem_3.25rem] gap-x-2 border-t border-line pt-1 font-mono text-[11px] text-dim">
        <span>total{detail.disqualified ? " (before disqualification)" : ""}</span>
        <span />
        <span />
        <span className="text-right text-ink">{fmt1(Math.round(total * 10) / 10)}</span>
      </div>
    </Section>
  );
}

function ComponentRow({ c }: { c: ComponentDetail }) {
  const inactive = c.weight <= 0;
  return (
    <li className={`py-1.5 ${inactive ? "opacity-60" : ""}`}>
      <div className="grid grid-cols-[1fr_3.5rem_2.75rem_3.25rem] items-baseline gap-x-2 text-[12px]">
        <span className="text-ink">{componentLabel(c.name)}</span>
        <span className="text-right font-mono text-[11px] text-dim tabular-nums">
          {fmt1(c.points)}/{fmt1(c.max)}
        </span>
        <span className="text-right font-mono text-[11px] text-faint tabular-nums">
          {fmt1(c.weight)}
        </span>
        <span
          className={`text-right font-mono text-[11px] tabular-nums ${
            c.contribution > 0 ? "text-ok" : "text-faint"
          }`}
        >
          +{fmt1(c.contribution)}
        </span>
      </div>
      {c.evidence.length > 0 ? (
        <ul className="mt-0.5 space-y-0.5 pl-2 text-[11px] leading-snug text-faint">
          {c.evidence.map((line, i) => (
            <li key={i} className="dp-evidence break-words">
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-0.5 pl-2 text-[11px] text-faint italic">no evidence recorded</p>
      )}
    </li>
  );
}

function LlmSection({ detail }: { detail: ListingDetail }) {
  const { llm } = detail;
  return (
    <Section title="Claude assessment">
      {llm ? (
        <div className="space-y-1 text-[12px]">
          <p className="font-mono text-[11px] text-dim">
            <span className={llm.adjustment >= 0 ? "text-ok" : "text-warn"}>
              {signed(llm.adjustment)}
            </span>{" "}
            · {llm.model} · {absoluteDate(new Date(llm.createdAt).getTime())}
          </p>
          <p className="whitespace-pre-wrap break-words text-dim" data-testid="llm-rationale">
            {llm.rationale}
          </p>
        </div>
      ) : (
        <p className="text-[12px] text-faint" data-testid="llm-none">
          No Claude assessment has run for this posting&apos;s current text
          {detail.hasPostingText
            ? ", so the score is the rule-based score alone."
            : " — it has no posting text, and stage 2 never runs on a title alone."}
        </p>
      )}
    </Section>
  );
}

function FetchSection({ detail }: { detail: ListingDetail }) {
  const { fetch } = detail;
  return (
    <Section title="Posting text" aside={detail.atsKind ?? undefined}>
      <div
        className={`text-[12px] ${fetch.failed ? "rounded border border-warn/50 px-2 py-1.5" : ""}`}
        data-testid="fetch-status"
      >
        <p className={fetch.failed ? "font-medium text-warn" : "text-dim"}>{fetch.label}</p>
        <p className="text-faint">{fetch.detail}</p>
      </div>
    </Section>
  );
}

function KeywordList({ words, tone }: { words: string[]; tone: "hit" | "miss" | "plain" }) {
  const cls =
    tone === "hit"
      ? "border-ok/50 text-ok"
      : tone === "miss"
        ? "border-bad/45 text-bad border-dashed"
        : "border-line text-dim";
  return (
    <ul className="flex flex-wrap gap-1">
      {words.map((w) => (
        <li
          key={w}
          data-keyword={tone}
          className={`rounded-sm border px-1 font-mono text-[10.5px] leading-[16px] ${cls}`}
        >
          {tone === "hit" ? "✓ " : tone === "miss" ? "✗ " : ""}
          {w}
        </li>
      ))}
    </ul>
  );
}

function ResumeSection({ match }: { match: ResumeMatchState }) {
  return (
    <Section title="Resume keywords">
      <div className="space-y-2 text-[12px]" data-testid="resume-match" data-state={match.state}>
        {match.state === "no-posting-text" && (
          <p className="text-faint">
            No posting text to compare against — keyword matching needs the description.
          </p>
        )}
        {match.state === "no-resume" && (
          <>
            <p className="text-faint">
              No resume uploaded yet — resume upload lands in Phase 4. Keywords this posting asks
              for:
            </p>
            {match.postingKeywords.length ? (
              <KeywordList words={match.postingKeywords} tone="plain" />
            ) : (
              <p className="text-faint italic">none recognised</p>
            )}
          </>
        )}
        {match.state === "matched" && (
          <>
            <p className="text-faint">
              {match.hits.length} of {match.hits.length + match.misses.length} posting keywords on
              your resume (uploaded {absoluteDay(new Date(match.resumeUploadedAt).getTime())}).
            </p>
            <div>
              <h4 className="mb-1 text-[11px] text-ok">On your resume</h4>
              {match.hits.length ? (
                <KeywordList words={match.hits} tone="hit" />
              ) : (
                <p className="text-faint italic">none</p>
              )}
            </div>
            <div>
              <h4 className="mb-1 text-[11px] text-bad">Missing from your resume</h4>
              {match.misses.length ? (
                <KeywordList words={match.misses} tone="miss" />
              ) : (
                <p className="text-faint italic">none</p>
              )}
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * Drafts whose save hasn't been confirmed, by listing. The panel follows the
 * cursor, so a Notes instance can unmount mid-save (j/k); if that save fails
 * the text is kept here and restored when the listing is opened again.
 */
const unsavedDrafts = new Map<string, string>();

type NotesState = "idle" | "dirty" | "saving" | "saved" | "error";

const NOTES_DEBOUNCE_MS = 1000;

function Notes({
  listingId,
  initial,
  onSave,
}: {
  listingId: string;
  initial: string;
  onSave: (listingId: string, notes: string) => Promise<SendResult>;
}) {
  const stashed = unsavedDrafts.get(listingId);
  const [draft, setDraft] = useState(stashed ?? initial);
  const [state, setState] = useState<NotesState>(stashed !== undefined ? "dirty" : "idle");
  const [error, setError] = useState<string | null>(null);

  const savedRef = useRef(initial);
  const draftRef = useRef(draft);
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const saveRef = useRef<() => Promise<void>>(async () => {});

  async function save(): Promise<void> {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const text = draftRef.current;
    if (text === savedRef.current) {
      unsavedDrafts.delete(listingId);
      if (mounted.current) setState((s) => (s === "dirty" || s === "error" ? "idle" : s));
      return;
    }
    if (inflight.current) return; // the running save re-checks when it lands
    inflight.current = true;
    unsavedDrafts.set(listingId, text);
    if (mounted.current) setState("saving");

    let result: SendResult;
    try {
      result = await onSave(listingId, text);
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    inflight.current = false;

    if (result.ok) {
      savedRef.current = text;
      if (draftRef.current === text) unsavedDrafts.delete(listingId);
      if (!mounted.current) return;
      setError(null);
      if (draftRef.current !== text) {
        setState("dirty");
        void saveRef.current();
      } else {
        setState("saved");
      }
    } else {
      // Keep every character: the draft stays in the box and in the stash.
      unsavedDrafts.set(listingId, draftRef.current);
      if (!mounted.current) return;
      setError(result.message);
      setState("error");
    }
  }

  // Re-bound after every render so timers and the unmount flush always call
  // the latest closure (current listingId / onSave).
  useLayoutEffect(() => {
    saveRef.current = save;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // Leaving the listing (j/k, close) flushes whatever is pending.
      if (draftRef.current !== savedRef.current) void saveRef.current();
    };
  }, []);

  function onChange(value: string) {
    draftRef.current = value;
    setDraft(value);
    setState("dirty");
    unsavedDrafts.set(listingId, value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void saveRef.current(), NOTES_DEBOUNCE_MS);
  }

  const label =
    state === "saving"
      ? "saving…"
      : state === "saved"
        ? "saved"
        : state === "dirty"
          ? "unsaved"
          : state === "error"
            ? "not saved"
            : "";

  return (
    <Section
      title="Notes"
      aside={
        <span className={state === "error" ? "text-bad" : state === "saved" ? "text-ok" : undefined} role="status">
          {label}
        </span>
      }
    >
      <textarea
        value={draft}
        maxLength={NOTES_MAX}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void saveRef.current()}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        rows={4}
        placeholder="Recruiter name, referral, what to mention…"
        aria-label="Listing notes"
        className="block w-full resize-y rounded border border-line bg-canvas px-2 py-1.5 text-[12px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
      />
      {state === "error" && (
        <div className="mt-1 flex items-start gap-2 text-[11px] text-bad" role="alert">
          <span className="flex-1">Couldn&apos;t save — your text is kept here. {error}</span>
          <button
            type="button"
            onClick={() => void saveRef.current()}
            className="shrink-0 rounded border border-line px-1.5 text-dim hover:text-ink"
          >
            Retry
          </button>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

function Timeline({ detail }: { detail: ListingDetail }) {
  const events = detail.application?.timeline ?? [];
  return (
    <Section title="Status timeline">
      {events.length === 0 ? (
        <p className="text-[12px] text-faint">No status changes yet — this listing is untracked.</p>
      ) : (
        <ol className="space-y-1 border-l border-line pl-3 text-[12px]" data-testid="timeline">
          {events.map((e, i) => (
            <li key={i} className="relative">
              <span className="absolute top-[7px] -left-[15.5px] h-1.5 w-1.5 rounded-full bg-faint" />
              <span className="text-dim">
                {e.fromStatus ? STATUS_FILTER_LABELS[e.fromStatus] : "—"}
              </span>
              <span className="mx-1 text-faint">→</span>
              <span className="text-ink">{STATUS_FILTER_LABELS[e.toStatus]}</span>
              <span className="ml-2 font-mono text-[10.5px] text-faint">
                {absoluteDate(new Date(e.occurredAt).getTime())}
              </span>
              {e.note && <p className="text-[11px] break-words text-faint">{e.note}</p>}
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}
