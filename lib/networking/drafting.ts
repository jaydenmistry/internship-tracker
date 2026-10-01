import { prisma } from "@/lib/db";
import { createDraftClient, DraftClientError, type DraftClient } from "@/lib/claude/draftClient";
import { getActiveResume } from "@/lib/resume/store";
import { loadNetworkingSettings } from "@/lib/networking/followups";
import {
  buildDraftPrompt,
  connectNoteRetryFeedback,
  connectNoteTooLong,
  CONNECT_NOTE_MAX,
  parseDraftOutput,
  selectVoiceExamples,
  type DraftType,
} from "@/lib/networking/draft";

/**
 * Draft one message for one contact: gather the inputs, build the prompt, call
 * the drafting client, parse, and — for a LinkedIn note — check the 300-char
 * limit in code (retry once with feedback, then return it with a warning).
 *
 * Nothing is saved here. The draft goes back to the browser to be edited;
 * only "Mark sent" stores a message, with this draft as its `draftBody`.
 */

export interface DraftResult {
  subject: string | null;
  body: string;
  /** Shown next to the draft, e.g. an over-long LinkedIn note. */
  warning: string | null;
}

export class DraftRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftRefusedError";
  }
}

export interface GenerateDraftInput {
  contactId: string;
  type: DraftType;
  listingId: string | null;
  nudge: string | null;
}

/** The model is chosen here, not in config/scoring.json: that file is hashed,
 *  and any edit to it would rescore the whole catalog. */
export function draftModel(): string {
  return process.env.DRAFTING_MODEL?.trim() || "claude-sonnet-5";
}

/**
 * Each draft spawns a Claude Code process (a couple of hundred MB). One user
 * can't need more than two at once; this stops a double-click storm.
 */
const MAX_CONCURRENT_DRAFTS = 2;
let inFlight = 0;

export async function generateDraft(
  input: GenerateDraftInput,
  client: DraftClient = createDraftClient({ model: draftModel() }),
): Promise<DraftResult> {
  if (inFlight >= MAX_CONCURRENT_DRAFTS) {
    throw new DraftRefusedError("A draft is already being written — wait for it to finish.");
  }
  inFlight += 1;
  try {
    return await generateDraftInner(input, client);
  } finally {
    inFlight -= 1;
  }
}

async function generateDraftInner(input: GenerateDraftInput, client: DraftClient): Promise<DraftResult> {
  // Sequential reads: concurrent queries through the `prisma dev` proxy have
  // failed with "bind message" errors.
  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: {
      name: true,
      title: true,
      kind: true,
      howMet: true,
      notes: true,
      doNotContact: true,
      companyId: true,
      company: { select: { name: true } },
    },
  });
  if (!contact) throw new DraftRefusedError(`no such contact: ${input.contactId}`);
  if (contact.doNotContact) throw new DraftRefusedError(`${contact.name} is marked do-not-contact.`);

  let listing: { title: string; company: string; postingText: string | null } | null = null;
  if (input.listingId) {
    const l = await prisma.listing.findUnique({
      where: { id: input.listingId },
      select: { title: true, postingText: true, companyId: true, company: { select: { name: true } } },
    });
    if (!l || l.companyId !== contact.companyId) {
      throw new DraftRefusedError("that listing isn't at this contact's company");
    }
    listing = { title: l.title, company: l.company.name, postingText: l.postingText };
  }

  const thread = await prisma.outreachMessage.findMany({
    where: { contactId: input.contactId },
    orderBy: [{ sentAt: "asc" }, { createdAt: "asc" }],
    select: { direction: true, type: true, channel: true, subject: true, body: true, sentAt: true },
  });
  const settings = await loadNetworkingSettings();
  // Voice examples come from EVERY contact: it's your voice, not theirs.
  const sent = await prisma.outreachMessage.findMany({
    where: { direction: "OUT", type: input.type, draftBody: { not: null } },
    orderBy: { sentAt: "desc" },
    take: 50,
    select: { direction: true, type: true, subject: true, body: true, draftBody: true, sentAt: true },
  });
  const resume = await getActiveResume();

  const base = {
    type: input.type,
    contact: {
      name: contact.name,
      title: contact.title,
      kind: contact.kind,
      company: contact.company?.name ?? null,
      howMet: contact.howMet,
      notes: contact.notes,
    },
    resumeText: resume?.text ?? null,
    voiceNotes: settings.voiceNotes,
    voiceExamples: selectVoiceExamples(sent, input.type, settings.voiceExampleCount),
    listing,
    thread,
    nudge: input.nudge,
  };

  const attempt = async (retryFeedback?: string) => {
    const { system, prompt } = buildDraftPrompt({ ...base, retryFeedback });
    const text = await client.complete({ system, prompt });
    const parsed = parseDraftOutput(text, input.type);
    if (!parsed) throw new DraftClientError("BadOutput", "Claude's reply wasn't a usable draft. Try Regenerate.");
    return parsed;
  };

  let draft = await attempt();
  let warning: string | null = null;
  if (input.type === "CONNECT_NOTE" && connectNoteTooLong(draft.body)) {
    draft = await attempt(connectNoteRetryFeedback(draft.body.length));
    if (connectNoteTooLong(draft.body)) {
      warning = `${draft.body.length} characters — over LinkedIn's ${CONNECT_NOTE_MAX}. Trim it before sending.`;
    }
  }
  return { ...draft, warning };
}
