import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import {
  createDraftClient,
  draftingConfigured,
  DraftClientError,
  type DraftClient,
} from "@/lib/claude/draftClient";
import { withDraftSlot } from "@/lib/claude/slots";
import { dropApplicationIfEmpty, lockApplication } from "@/lib/applications/keep";
import { createApplicationFor } from "@/lib/listings/mutations";
import { primaryLocation } from "@/lib/listings/location";
import { loadNetworkingSettings } from "@/lib/networking/followups";
import { draftModel } from "@/lib/networking/drafting";
import { getActiveResume } from "@/lib/resume/store";
import {
  buildCoverLetterPrompt,
  parseCoverLetterOutput,
  selectLetterExamples,
  wordCount,
} from "./prompt";

/**
 * Cover letters: one per application, drafted by Claude on the user's
 * subscription through the same locked-down client as the networking drafts
 * (lib/claude/draftClient.ts), then edited and saved here.
 *
 * A listing you haven't applied to yet has no Application row; the first
 * letter creates one with status NOT_APPLIED, the same way notes do, and that
 * row is then kept for as long as the letter exists (lib/applications/keep.ts).
 * The row is only created AFTER a draft succeeds, so a failed call leaves
 * nothing behind.
 */

export type CoverLetterTarget = { listingId: string } | { applicationId: string };

export class CoverLetterRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverLetterRefusedError";
  }
}

export interface CoverLetterView {
  body: string;
  greeting: string | null;
  recipient: string | null;
  draftBody: string | null;
  checks: string[];
  postingText: string | null;
  model: string | null;
  generatedAt: string | null;
  updatedAt: string;
}

export interface CoverLetterPage {
  /** How the page was addressed — the editor sends it back on every action. */
  target: CoverLetterTarget;
  applicationId: string | null;
  listingId: string | null;
  company: string;
  role: string;
  location: string | null;
  /** Words of fetched posting text on the listing (0 when none). */
  listingPostingWords: number;
  resume: { filename: string; uploadedAt: string } | null;
  draftingReady: boolean;
  letter: CoverLetterView | null;
}

const LETTER_SELECT = {
  body: true,
  greeting: true,
  recipient: true,
  draftBody: true,
  checks: true,
  postingText: true,
  model: true,
  generatedAt: true,
  updatedAt: true,
} as const;

function view(l: {
  body: string;
  greeting: string | null;
  recipient: string | null;
  draftBody: string | null;
  checks: string[];
  postingText: string | null;
  model: string | null;
  generatedAt: Date | null;
  updatedAt: Date;
}): CoverLetterView {
  return {
    ...l,
    generatedAt: l.generatedAt?.toISOString() ?? null,
    updatedAt: l.updatedAt.toISOString(),
  };
}

interface Resolved {
  applicationId: string | null;
  listingId: string | null;
  company: string;
  role: string;
  location: string | null;
  listingPostingText: string | null;
  letter: CoverLetterView | null;
}

/** Finds the application (if any) and listing (if any) a target points at. */
async function resolve(target: CoverLetterTarget): Promise<Resolved | null> {
  const listingSelect = {
    id: true,
    title: true,
    locations: true,
    remote: true,
    postingText: true,
    company: { select: { name: true } },
  } as const;

  if ("listingId" in target) {
    const listing = await prisma.listing.findUnique({
      where: { id: target.listingId },
      select: {
        ...listingSelect,
        application: { select: { id: true, coverLetter: { select: LETTER_SELECT } } },
      },
    });
    if (!listing) return null;
    const letter = listing.application?.coverLetter ?? null;
    return {
      applicationId: listing.application?.id ?? null,
      listingId: listing.id,
      company: listing.company.name,
      role: listing.title,
      location: primaryLocation(listing.locations, listing.remote),
      listingPostingText: listing.postingText,
      letter: letter ? view(letter) : null,
    };
  }

  const app = await prisma.application.findUnique({
    where: { id: target.applicationId },
    select: {
      id: true,
      companyName: true,
      roleTitle: true,
      location: true,
      listing: { select: listingSelect },
      coverLetter: { select: LETTER_SELECT },
    },
  });
  if (!app) return null;
  return {
    applicationId: app.id,
    listingId: app.listing?.id ?? null,
    company: app.listing?.company.name ?? app.companyName ?? "(unknown company)",
    role: app.listing?.title ?? app.roleTitle ?? "(unknown role)",
    location: app.listing ? primaryLocation(app.listing.locations, app.listing.remote) : app.location,
    listingPostingText: app.listing?.postingText ?? null,
    letter: app.coverLetter ? view(app.coverLetter) : null,
  };
}

export async function loadCoverLetterPage(target: CoverLetterTarget): Promise<CoverLetterPage | null> {
  const r = await resolve(target);
  if (!r) return null;
  const resume = await getActiveResume();
  return {
    target,
    applicationId: r.applicationId,
    listingId: r.listingId,
    company: r.company,
    role: r.role,
    location: r.location,
    listingPostingWords: wordCount(r.listingPostingText ?? ""),
    resume: resume ? { filename: resume.filename, uploadedAt: resume.uploadedAt.toISOString() } : null,
    draftingReady: draftingConfigured(),
    letter: r.letter,
  };
}

/**
 * The application row for a target RIGHT NOW, creating a NOT_APPLIED one for
 * an un-applied listing. Re-resolved at write time, not reused from before a
 * draft: during the minute a draft takes, the listing may have been applied
 * to in another tab (so a row now exists — creating another would hit the
 * unique listingId) or a notes-only row may have been dropped.
 */
async function ensureApplication(target: CoverLetterTarget, now: Date): Promise<string> {
  const r = await resolve(target);
  if (!r) throw new CoverLetterRefusedError("That listing or application no longer exists.");
  if (r.applicationId) return r.applicationId;
  if (!r.listingId) throw new CoverLetterRefusedError("That application no longer exists.");
  try {
    return (await createApplicationFor(r.listingId, "NOT_APPLIED", now)).id;
  } catch (err) {
    // Created by someone else between the read and the insert: use theirs.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const again = await prisma.application.findUnique({ where: { listingId: r.listingId }, select: { id: true } });
      if (again) return again.id;
    }
    throw err;
  }
}

/**
 * Writes the letter row for a target. If the application vanished between
 * finding it and writing (a notes-only row dropped in another tab — a foreign
 * key failure), find or create it once more and retry, rather than showing a
 * raw database error over text the user just wrote.
 */
async function writeLetter<T>(
  target: CoverLetterTarget,
  now: Date,
  write: (applicationId: string) => Promise<T>,
): Promise<T> {
  try {
    return await write(await ensureApplication(target, now));
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2003") {
      return write(await ensureApplication(target, now));
    }
    throw err;
  }
}

export interface GenerateCoverLetterInput {
  target: CoverLetterTarget;
  /**
   * Which description to draft from: the listing's fetched posting text, or
   * `postingText` pasted into the editor. Explicit, so switching back to the
   * fetched posting really does stop using an earlier paste.
   */
  source: "listing" | "pasted";
  postingText: string | null;
  nudge: string | null;
}

/**
 * Drafts a letter and saves it, replacing the current body. The editor asks
 * before regenerating over edits; this function does not second-guess it.
 */
export async function generateCoverLetter(
  input: GenerateCoverLetterInput,
  client: DraftClient = createDraftClient({ model: draftModel(), timeoutMs: 150_000 }),
  opts: { now?: Date } = {},
): Promise<CoverLetterView> {
  const now = opts.now ?? new Date();
  const r = await resolve(input.target);
  if (!r) throw new CoverLetterRefusedError("That listing or application no longer exists.");

  const pasted = input.source === "pasted" ? input.postingText?.trim() || null : null;
  const postingText = input.source === "pasted" ? pasted : r.listingPostingText?.trim() || null;
  if (!postingText) {
    throw new CoverLetterRefusedError(
      input.source === "pasted"
        ? "The pasted description is empty."
        : "There's no job description to work from. Paste the description from the posting first.",
    );
  }

  const resume = await getActiveResume();
  if (!resume || resume.text.trim() === "") {
    throw new CoverLetterRefusedError("Upload your resume on /resume first — the letter is built from it.");
  }

  const settings = await loadNetworkingSettings();
  const others = await prisma.coverLetter.findMany({
    where: { draftBody: { not: null }, ...(r.applicationId ? { applicationId: { not: r.applicationId } } : {}) },
    orderBy: { updatedAt: "desc" },
    take: 20,
    select: { body: true, draftBody: true, updatedAt: true },
  });

  const model = draftModel();
  const draft = await withDraftSlot(
    async () => {
      const { system, prompt } = buildCoverLetterPrompt({
        company: r.company,
        role: r.role,
        location: r.location,
        postingText,
        resumeText: resume.text,
        voiceNotes: settings.voiceNotes,
        voiceExamples: selectLetterExamples(others),
        nudge: input.nudge,
      });
      const text = await client.complete({ system, prompt });
      const parsed = parseCoverLetterOutput(text);
      if (!parsed) throw new DraftClientError("BadOutput", "Claude's reply wasn't a usable letter. Try again.");
      return parsed;
    },
    () => new CoverLetterRefusedError("A draft is already being written — wait for it to finish."),
  );

  // A paste is kept only while it's the chosen source; drafting from the
  // listing clears it, so a later fetch of the posting is never shadowed.
  const fields = {
    body: draft.body,
    draftBody: draft.body,
    checks: draft.checks,
    postingText: pasted,
    model,
    generatedAt: now,
  };
  const saved = await writeLetter(input.target, now, (applicationId) =>
    prisma.coverLetter.upsert({
      where: { applicationId },
      // Claude's greeting only when the posting named whom to address; a
      // greeting you set yourself is never replaced by a regenerate otherwise.
      create: { applicationId, ...fields, greeting: draft.greeting },
      update: { ...fields, ...(draft.greeting ? { greeting: draft.greeting } : {}) },
      select: LETTER_SELECT,
    }),
  );
  return view(saved);
}

export interface CoverLetterEdits {
  body: string;
  /** Blank means "use the profile's default". */
  greeting: string;
  recipient: string;
}

/** Saves your edits. Writing a letter from scratch (no draft) works too. */
export async function saveCoverLetter(
  target: CoverLetterTarget,
  edits: CoverLetterEdits,
  opts: { now?: Date } = {},
): Promise<CoverLetterView> {
  const body = edits.body.replace(/\r\n?/g, "\n");
  if (body.trim() === "") {
    throw new CoverLetterRefusedError("The letter is empty. Use Delete to remove it instead.");
  }
  const greeting = edits.greeting.replace(/\s+/g, " ").trim() || null;
  const recipient =
    edits.recipient
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n") || null;
  const saved = await writeLetter(target, opts.now ?? new Date(), (applicationId) =>
    prisma.coverLetter.upsert({
      where: { applicationId },
      create: { applicationId, body, greeting, recipient, checks: [] },
      update: { body, greeting, recipient },
      select: LETTER_SELECT,
    }),
  );
  return view(saved);
}

/**
 * Deletes the letter. If its application was a NOT_APPLIED row with nothing
 * else on it, the row goes too — back to the canonical "no row" state.
 */
export async function deleteCoverLetter(target: CoverLetterTarget): Promise<void> {
  const r = await resolve(target);
  if (!r?.applicationId) return;
  const applicationId = r.applicationId;
  // One transaction under the row lock: delete the letter, then drop the
  // row only if — checked under that same lock — it is still NOT_APPLIED and
  // holds nothing else (a note saved in another tab meanwhile keeps it).
  await prisma.$transaction(async (tx) => {
    await lockApplication(tx, applicationId);
    await tx.coverLetter.deleteMany({ where: { applicationId } });
    await dropApplicationIfEmpty(applicationId, { requireStatus: "NOT_APPLIED", tx });
  });
}
