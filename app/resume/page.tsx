import type { Metadata } from "next";
import { format, formatDistanceToNowStrict } from "date-fns";
import Badge from "@/components/Badge";
import { buildVocabulary, extractKeywords } from "@/lib/resume/match";
import { MAX_RESUME_CHARS } from "@/lib/resume/limits";
import { getActiveResume, listResumeHistory } from "@/lib/resume/store";
import { loadScoringConfig } from "@/lib/scoring/config";
import UploadForm from "./UploadForm";

export const metadata: Metadata = {
  title: "Resume · Internship Tracker",
  description: "Upload the resume that postings are keyword-matched against.",
};

// The active resume changes on upload; never serve a cached copy of this page.
export const dynamic = "force-dynamic";

/** How many of the found keywords to show before collapsing to a count. */
const KEYWORD_PREVIEW = 20;
/** Enough of the text to confirm the right document was parsed. */
const TEXT_PREVIEW_CHARS = 600;

export default async function ResumePage() {
  // Sequential on purpose: concurrent queries through the `prisma dev` proxy
  // intermittently fail with "bind message supplies N parameters". Both are tiny.
  const resume = await getActiveResume();
  const history = await listResumeHistory();

  let keywords: string[] | null = null;
  try {
    keywords = resume
      ? extractKeywords(resume.text, buildVocabulary(loadScoringConfig().config))
      : null;
  } catch {
    // A broken config/scoring.json is a scoring problem, not a reason to lose
    // the upload form. The keyword preview is simply omitted.
    keywords = null;
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
      <header>
        <h1 className="text-base font-semibold tracking-tight">Resume</h1>
        <p className="mt-1 max-w-prose text-dim">
          One resume at a time. Its text is matched against each posting to show
          which keywords you already cover and which you don&apos;t — a tailoring
          aid. It never feeds into a listing&apos;s score.
        </p>
      </header>

      {resume ? (
        <section className="rounded border border-line bg-panel">
          <div className="flex items-center justify-between border-b border-line-soft px-3 py-1.5">
            <span className="font-mono text-[11px] tracking-wide text-faint uppercase">
              active resume
            </span>
            <Badge tone="ok" solid>
              in use
            </Badge>
          </div>

          <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-4 gap-y-1 px-3 py-3">
            <dt className="text-[11px] text-faint uppercase">File</dt>
            {/* Browser-supplied name: sanitized at save, rendered as text. */}
            <dd className="min-w-0 truncate font-mono text-[12px]">{resume.filename}</dd>

            <dt className="text-[11px] text-faint uppercase">Uploaded</dt>
            <dd>
              <time dateTime={resume.uploadedAt.toISOString()} title={absolute(resume.uploadedAt)}>
                {relative(resume.uploadedAt)}
              </time>
            </dd>

            <dt className="text-[11px] text-faint uppercase">Extracted</dt>
            <dd className="font-mono tabular-nums">
              {resume.text.length.toLocaleString("en-US")} chars
              {resume.text.length >= MAX_RESUME_CHARS && (
                <span className="ml-2 font-sans text-[11px] text-warn">
                  at the {MAX_RESUME_CHARS.toLocaleString("en-US")} character cap
                </span>
              )}
            </dd>

            <dt className="text-[11px] text-faint uppercase">Keywords</dt>
            <dd>
              {keywords === null ? (
                <span className="text-faint">unavailable (scoring config could not be read)</span>
              ) : keywords.length === 0 ? (
                <span className="text-warn">
                  none recognised — the text extracted, but none of the tracked skills appear in it
                </span>
              ) : (
                <span className="font-mono tabular-nums">{keywords.length} found</span>
              )}
            </dd>
          </dl>

          {keywords !== null && keywords.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 border-t border-line-soft px-3 py-2">
              {keywords.slice(0, KEYWORD_PREVIEW).map((label) => (
                <span
                  key={label}
                  className="rounded border border-ok/40 px-1.5 py-[1px] font-mono text-[11px] text-ok"
                >
                  {label}
                </span>
              ))}
              {keywords.length > KEYWORD_PREVIEW && (
                <span className="text-[11px] text-faint">
                  +{keywords.length - KEYWORD_PREVIEW} more
                </span>
              )}
            </div>
          )}

          <details className="border-t border-line-soft px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-dim hover:text-ink">
              Extracted text preview
            </summary>
            {/* PDF text layers are untrusted input; React escapes it as text. */}
            <p className="mt-2 max-h-40 overflow-y-auto font-mono text-[11px] leading-5 whitespace-pre-wrap text-faint">
              {resume.text.slice(0, TEXT_PREVIEW_CHARS)}
              {resume.text.length > TEXT_PREVIEW_CHARS && " …"}
            </p>
          </details>
        </section>
      ) : (
        <p className="rounded border border-line border-dashed px-3 py-6 text-center text-dim">
          No resume uploaded yet. Until there is one, the detail panel lists a
          posting&apos;s keywords without saying which you already cover.
        </p>
      )}

      <UploadForm replacing={resume !== null} />

      {history.length > 0 && (
        <section className="rounded border border-line bg-panel">
          <div className="border-b border-line-soft px-3 py-1.5 font-mono text-[11px] tracking-wide text-faint uppercase">
            replaced
          </div>
          <ul className="divide-y divide-line-soft">
            {history.map((old) => (
              <li key={old.id} className="flex items-baseline gap-3 px-3 py-1.5">
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-dim">
                  {old.filename}
                </span>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-faint">
                  {old.chars.toLocaleString("en-US")} chars
                </span>
                <time
                  dateTime={old.uploadedAt.toISOString()}
                  title={absolute(old.uploadedAt)}
                  className="shrink-0 text-[11px] text-faint"
                >
                  {relative(old.uploadedAt)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** "3 days ago" — the absolute timestamp rides along in the title attribute. */
function relative(date: Date): string {
  return `${formatDistanceToNowStrict(date)} ago`;
}

function absolute(date: Date): string {
  return format(date, "yyyy-MM-dd HH:mm");
}
