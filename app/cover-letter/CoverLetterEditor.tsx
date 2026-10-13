"use client";

import Link from "next/link";
import { useEffect, useState, useTransition, type MouseEvent } from "react";
import type { CoverLetterPage, CoverLetterView } from "@/lib/coverletter/letters";
import type { LetterProfile } from "@/lib/coverletter/profile-schema";
import {
  composeLetter,
  defaultGreeting,
  defaultRecipient,
  exportFilename,
  isCivilDate,
  todayCivil,
} from "@/lib/coverletter/compose";
import { COVER_LETTER_CAPS, COVER_LETTER_MAX, isEdited, PASTED_POSTING_MAX, wordCount } from "@/lib/coverletter/prompt";
import { deleteCoverLetterAction, generateCoverLetterAction, saveCoverLetterAction } from "./actions";

/**
 * Draft → edit → save → download. Claude writes the body paragraphs from the
 * posting and your resume; you edit them here (later letters learn your
 * voice from those edits); Save keeps the letter on the application.
 * Download builds a PDF or .docx in the browser with your letterhead
 * (/cover-letter/settings), the date, recipient, greeting and signature.
 * Everything is edited in plain inputs, never rendered as markup.
 */

const INPUT = "w-full rounded border border-line bg-raised px-2 py-1 text-[13px] text-ink placeholder:text-faint";
const BTN = "rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink disabled:opacity-60";
const PRIMARY = "rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60";

type Format = "pdf" | "docx";
const FORMAT_KEY = "coverLetter.format";

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface Saved {
  body: string;
  greeting: string;
  recipient: string;
}

const fromLetter = (l: CoverLetterView | null): Saved => ({
  body: l?.body ?? "",
  greeting: l?.greeting ?? "",
  recipient: l?.recipient ?? "",
});

export default function CoverLetterEditor({ page, profile }: { page: CoverLetterPage; profile: LetterProfile }) {
  const [letter, setLetter] = useState<CoverLetterView | null>(page.letter);
  const [saved, setSaved] = useState<Saved>(() => fromLetter(page.letter));
  const [body, setBody] = useState(saved.body);
  const [greeting, setGreeting] = useState(saved.greeting);
  const [recipient, setRecipient] = useState(saved.recipient);
  const [nudge, setNudge] = useState("");
  const [source, setSource] = useState<"listing" | "pasted">(
    page.letter?.postingText || page.listingPostingWords === 0 ? "pasted" : "listing",
  );
  const [pasted, setPasted] = useState(page.letter?.postingText ?? "");
  // Set after mount, from the BROWSER's clock: the server's "today" (and its
  // timezone) would disagree with the client's on hydration.
  const [date, setDate] = useState("");
  const [mounted, setMounted] = useState(false);
  const [format, setFormat] = useState<Format>("pdf");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [drafting, startDrafting] = useTransition();
  const [saving, startSaving] = useTransition();

  const dirty = body !== saved.body || greeting !== saved.greeting || recipient !== saved.recipient;
  const words = wordCount(body);
  const hasPosting = source === "pasted" ? pasted.trim() !== "" : page.listingPostingWords > 0;
  const profileEmpty = !profile.name.trim() && profile.contactLines.length === 0;

  // The chosen download format is a per-browser convenience.
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- browser-only values, read once after mount */
    setDate(todayCivil());
    setMounted(true);
    /* eslint-enable react-hooks/set-state-in-effect */
    try {
      const stored = window.localStorage.getItem(FORMAT_KEY);
      if (stored === "pdf" || stored === "docx") setFormat(stored);
    } catch {
      /* storage blocked: keep the default */
    }
  }, []);
  const chooseFormat = (f: Format) => {
    setFormat(f);
    try {
      window.localStorage.setItem(FORMAT_KEY, f);
    } catch {
      /* ignore */
    }
  };

  // A full page unload with unsaved edits asks first; in-app links do too (below).
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);
  const guardLeave = (e: MouseEvent) => {
    if (dirty && !window.confirm("Leave without saving your changes?")) e.preventDefault();
  };

  /**
   * Takes the server's copy of the letter as the new saved state. A field is
   * replaced only if it still holds what was sent — anything typed while the
   * request was in flight stays (and shows as unsaved).
   */
  const adopt = (l: CoverLetterView, sent: Saved) => {
    const next = fromLetter(l);
    setLetter(l);
    setSaved(next);
    setBody((b) => (b === sent.body ? next.body : b));
    setGreeting((g) => (g === sent.greeting ? next.greeting : g));
    setRecipient((r) => (r === sent.recipient ? next.recipient : r));
  };

  const onGenerate = () => {
    if (body.trim() !== "" && isEdited(body, letter?.draftBody ?? null)) {
      if (!window.confirm("Replace the letter's body with a new draft? Your edits to it will be lost.")) return;
    }
    setError(null);
    setNotice(null);
    const sentGreeting = greeting;
    startDrafting(async () => {
      let res: Awaited<ReturnType<typeof generateCoverLetterAction>>;
      try {
        res = await generateCoverLetterAction({
          target: page.target,
          source,
          postingText: source === "pasted" ? pasted : null,
          nudge: nudge.trim() || null,
        });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        // The body is replaced (it was read-only while drafting). Greeting and
        // recipient change only if Claude gave a greeting and you haven't
        // touched the box since — a draft never undoes what you typed.
        const draft = res.letter;
        setLetter(draft);
        setSaved((prev) => ({ ...prev, body: draft.body, ...(draft.greeting ? { greeting: draft.greeting } : {}) }));
        setBody(draft.body);
        if (draft.greeting) setGreeting((g) => (g === sentGreeting ? (draft.greeting ?? g) : g));
        setNotice("Draft saved. Edit it, then Save.");
      } else {
        setError(res.message);
      }
    });
  };

  const onSave = () => {
    setError(null);
    setNotice(null);
    const sent: Saved = { body, greeting, recipient };
    startSaving(async () => {
      let res: Awaited<ReturnType<typeof saveCoverLetterAction>>;
      try {
        res = await saveCoverLetterAction({ target: page.target, ...sent });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        adopt(res.letter, sent);
        setNotice("Saved.");
      } else {
        setError(res.message);
      }
    });
  };

  const onDelete = () => {
    if (!window.confirm("Delete this cover letter? This can't be undone.")) return;
    setError(null);
    setNotice(null);
    startSaving(async () => {
      let res: Awaited<ReturnType<typeof deleteCoverLetterAction>>;
      try {
        res = await deleteCoverLetterAction({ target: page.target });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) {
        setLetter(null);
        const empty = fromLetter(null);
        setSaved(empty);
        setBody("");
        setGreeting("");
        setRecipient("");
        setNotice("Deleted.");
      } else {
        setError(res.message);
      }
    });
  };

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Couldn't copy — select the text and copy it yourself.");
    }
  };

  const onDownload = async () => {
    if (!isCivilDate(date)) {
      setError("Pick the letter's date first.");
      return;
    }
    setError(null);
    setExporting(true);
    try {
      const doc = composeLetter({ profile, company: page.company, recipient, greeting, body, date });
      const name = exportFilename(date, page.company, format);
      if (format === "pdf") {
        // Loaded on demand: pdf-lib is a few hundred KB the page doesn't need until now.
        const { buildPdf, PDF_MIME } = await import("@/lib/coverletter/pdf");
        download(name, await buildPdf(doc, { title: `Cover Letter — ${page.company}` }), PDF_MIME);
      } else {
        const { buildDocx, DOCX_MIME } = await import("@/lib/coverletter/docx");
        download(name, buildDocx(doc), DOCX_MIME);
      }
    } catch (err) {
      setError(`Couldn't build the file: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExporting(false);
    }
  };

  const backHref = page.listingId ? "/" : "/tracker";
  const greetingDefault = defaultGreeting(profile, page.company);
  const recipientDefault = defaultRecipient(profile, page.company);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-3">
      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link href={backHref} onClick={guardLeave} className="text-[12px] text-faint hover:text-ink">
          ← {page.listingId ? "Listings" : "Tracker"}
        </Link>
        <h1 className="text-[15px] font-medium text-ink">
          Cover letter · {page.company} — {page.role}
        </h1>
        {page.location && <span className="text-[12px] text-faint">{page.location}</span>}
        <Link href="/cover-letter/settings" onClick={guardLeave} className="ml-auto text-[12px] text-dim hover:text-ink">
          Letterhead &amp; signature
        </Link>
      </header>

      {profileEmpty && (
        <p className="rounded border border-warn/50 px-3 py-2 text-[12px] text-warn">
          Set up your{" "}
          <Link href="/cover-letter/settings" onClick={guardLeave} className="underline">
            letterhead and signature
          </Link>{" "}
          once — your name and contact lines go at the top of every downloaded letter.
        </p>
      )}

      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_20rem]">
        {/* The letter */}
        <section aria-label="Letter" className="flex min-w-0 flex-col gap-2 rounded border border-line bg-panel p-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-dim">To</span>
              <textarea
                aria-label="Recipient"
                value={recipient}
                rows={4}
                maxLength={1000}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder={recipientDefault}
                className={`${INPUT} text-[12px]`}
              />
              <span className="text-[11px] text-faint">Add the company&apos;s address here if you have it.</span>
            </label>
            <label className="flex flex-col gap-1 text-[12px]">
              <span className="text-dim">Greeting</span>
              <input
                aria-label="Greeting"
                value={greeting}
                maxLength={200}
                onChange={(e) => setGreeting(e.target.value)}
                placeholder={greetingDefault}
                className={`${INPUT} h-7 py-0`}
              />
              <span className="text-[11px] text-faint">Blank uses the placeholder shown.</span>
            </label>
          </div>

          <textarea
            aria-label="Cover letter"
            value={body}
            readOnly={drafting}
            maxLength={COVER_LETTER_MAX}
            rows={20}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
                e.preventDefault();
                if (dirty && body.trim() !== "" && !saving) onSave();
              }
            }}
            placeholder={
              page.draftingReady
                ? "The body paragraphs. Click Draft with Claude, or write them yourself — the letterhead, date, greeting and sign-off are added when you download."
                : "The body paragraphs — the letterhead, date, greeting and sign-off are added when you download."
            }
            className={`${INPUT} min-h-[22rem] leading-relaxed ${drafting ? "opacity-60" : ""}`}
          />
          <p className="text-[11px] text-faint">
            Then: {profile.closing} {profile.signature ? "[signature] " : ""}
            {profile.name || "(your name — set it in Letterhead)"}
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={onSave} disabled={!dirty || body.trim() === "" || saving || drafting} className={PRIMARY}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" onClick={onCopy} disabled={body.trim() === ""} className={BTN}>
              {copied ? "Copied" : "Copy text"}
            </button>
            {letter && (
              <button type="button" onClick={onDelete} disabled={saving || drafting} className={`${BTN} hover:text-bad`}>
                Delete
              </button>
            )}
            <span className="ml-auto font-mono text-[11px] text-faint" data-testid="word-count">
              {words} {words === 1 ? "word" : "words"}
              {words > 400 ? " · long for a cover letter" : ""}
            </span>
          </div>
          <p className="text-[11px] text-faint" aria-live="polite">
            {dirty
              ? "Unsaved changes (Ctrl+S saves)."
              : letter
                ? `Saved${mounted ? ` ${new Date(letter.updatedAt).toLocaleString()}` : ""}.`
                : "Not saved yet."}
          </p>

          <div className="flex flex-wrap items-end gap-2 border-t border-line-soft pt-2 text-[12px]" aria-label="Download">
            <label className="flex flex-col gap-1">
              <span className="text-dim">Date on the letter</span>
              <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={`${INPUT} h-7 py-0`} />
            </label>
            <div role="radiogroup" aria-label="File format" className="flex overflow-hidden rounded border border-line">
              {(["pdf", "docx"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={format === f}
                  onClick={() => chooseFormat(f)}
                  className={`px-3 py-1 ${format === f ? "bg-accent text-accent-ink" : "text-dim hover:text-ink"}`}
                >
                  {f === "pdf" ? "PDF" : "Word"}
                </button>
              ))}
            </div>
            <button type="button" onClick={onDownload} disabled={body.trim() === "" || exporting} className={PRIMARY}>
              {exporting ? "Building…" : `Download ${format === "pdf" ? "PDF" : ".docx"}`}
            </button>
            <span className="font-mono text-[11px] text-faint" data-testid="export-name">
              {isCivilDate(date) ? exportFilename(date, page.company, format) : ""}
            </span>
          </div>

          {notice && !error && <p className="text-[12px] text-ok">{notice}</p>}
          {error && (
            <p role="alert" className="text-[12px] text-bad">
              {error}
            </p>
          )}
        </section>

        {/* Inputs and Claude's notes */}
        <aside className="flex flex-col gap-3">
          <section aria-label="Draft with Claude" className="flex flex-col gap-2 rounded border border-line bg-panel p-3 text-[12px]">
            <h2 className="font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">Draft with Claude</h2>

            {!page.resume ? (
              <p className="text-warn">
                No resume uploaded. The letter is built from it —{" "}
                <Link href="/resume" onClick={guardLeave} className="underline">
                  upload one
                </Link>{" "}
                first.
              </p>
            ) : (
              <p className="text-dim">
                Resume: <span className="text-ink">{page.resume.filename}</span>
              </p>
            )}

            <div role="radiogroup" aria-label="Job description" className="flex flex-col gap-1 text-dim">
              <span>Job description</span>
              <label className={`flex items-center gap-2 ${page.listingPostingWords === 0 ? "opacity-50" : ""}`}>
                <input
                  type="radio"
                  name="source"
                  checked={source === "listing"}
                  disabled={page.listingPostingWords === 0}
                  onChange={() => setSource("listing")}
                  className="accent-[var(--accent)]"
                />
                {page.listingPostingWords > 0
                  ? `The fetched posting (${page.listingPostingWords} words)`
                  : "The fetched posting (none for this role)"}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="source"
                  checked={source === "pasted"}
                  onChange={() => setSource("pasted")}
                  className="accent-[var(--accent)]"
                />
                A description I paste
              </label>
            </div>
            {source === "pasted" && (
              <textarea
                aria-label="Pasted job description"
                value={pasted}
                maxLength={PASTED_POSTING_MAX}
                rows={7}
                onChange={(e) => setPasted(e.target.value)}
                placeholder="Paste the job description from the posting page."
                className={`${INPUT} text-[12px]`}
              />
            )}

            <label className="flex flex-col gap-1">
              <span className="text-dim">Anything to emphasize? (optional)</span>
              <input
                value={nudge}
                maxLength={COVER_LETTER_CAPS.nudge}
                onChange={(e) => setNudge(e.target.value)}
                placeholder="e.g. lead with my distributed systems project"
                className={`${INPUT} h-7 py-0`}
              />
            </label>

            {!page.draftingReady && (
              <p className="text-warn" data-testid="draft-blocked">
                Claude isn&apos;t connected — set CLAUDE_CODE_OAUTH_TOKEN (see /network/settings). You can still write
                the letter by hand.
              </p>
            )}
            <button
              type="button"
              onClick={onGenerate}
              disabled={drafting || saving || !page.draftingReady || !page.resume || !hasPosting}
              className={`${PRIMARY} self-start`}
            >
              {drafting ? "Drafting… (up to a minute)" : letter?.draftBody ? "Regenerate" : "Draft with Claude"}
            </button>
            <p className="text-[11px] leading-snug text-faint">
              Sends to Anthropic, through your Claude account: the role&apos;s description, your resume, your voice notes,
              and up to two of your past edited cover letters. Claude is told to use only facts from your resume — still
              read every line before you send it.
            </p>
          </section>

          {letter && letter.checks.length > 0 && (
            <section aria-label="Check before sending" className="rounded border border-warn/50 bg-panel p-3 text-[12px]">
              <h2 className="mb-1.5 font-mono text-[10px] font-semibold tracking-wide text-warn uppercase">
                Check before sending
              </h2>
              <ul className="list-disc space-y-1 pl-4 text-dim">
                {letter.checks.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
