import type { OutreachChannel } from "@/generated/prisma/enums";
import type { DueKind } from "@/lib/networking/followup";
import { CONNECT_NOTE_MAX, DRAFT_TYPES, draftUsesSubject, type DraftType } from "@/lib/networking/draft";
import type { MessageInputRaw } from "@/lib/networking/schema";

/**
 * Pure logic for the draft panel: which draft type a due item implies, the
 * channels each type can go out on, the mailto: link, and the "Mark sent"
 * payload. No React, no I/O.
 */

/** The Draft button, labelled for what's due. */
export const DRAFT_LABELS: Record<DueKind, string> = {
  FOLLOW_UP: "Draft follow-up",
  THANK_YOU: "Draft thank-you",
  SEND_OPENER: "Draft opener",
  CHECK_IN: "Draft follow-up",
};

/** A draft opens pre-set to what's due. */
export function draftTypeForDue(kind: DueKind | null): DraftType {
  switch (kind) {
    case "THANK_YOU":
      return "THANK_YOU";
    case "FOLLOW_UP":
    case "CHECK_IN":
      return "FOLLOW_UP";
    default:
      return "COLD";
  }
}

/** `?draft=` from a Due list or "People at" link, validated. */
export function parseDraftParam(v: string | null | undefined): DraftType | null {
  return v && (DRAFT_TYPES as readonly string[]).includes(v) ? (v as DraftType) : null;
}

/** Channels a draft of this type can be sent on — a subset of MESSAGE_RULES. */
export function draftChannels(type: DraftType): OutreachChannel[] {
  return type === "CONNECT_NOTE" ? ["LINKEDIN"] : ["EMAIL", "LINKEDIN"];
}

export function defaultDraftChannel(type: DraftType, preferLinkedIn: boolean): OutreachChannel {
  if (type === "CONNECT_NOTE") return "LINKEDIN";
  return preferLinkedIn ? "LINKEDIN" : "EMAIL";
}

/**
 * Some Windows mail clients truncate or refuse mailto: URLs past ~2,000
 * characters, silently cutting the body. Past this, only Copy is offered.
 */
export const MAILTO_MAX = 1800;

/**
 * A mailto: with the subject and body, or null when there's no plain address
 * or the URL would be too long. The address is checked strictly (no
 * `?`/`&`/`#`/whitespace) so it can't smuggle extra headers like `bcc=`;
 * subject and body are percent-encoded.
 */
export function buildMailto(email: string | null, subject: string, body: string): string | null {
  if (!email) return null;
  const to = email.trim();
  if (!/^[^\s@?&#<>"%]+@[^\s@?&#<>"%]+$/.test(to)) return null;
  const params = [
    subject.trim() ? `subject=${encodeURIComponent(subject.trim())}` : null,
    body ? `body=${encodeURIComponent(body.replace(/\r?\n/g, "\r\n"))}` : null,
  ].filter(Boolean);
  const url = `mailto:${to}${params.length ? `?${params.join("&")}` : ""}`;
  return url.length <= MAILTO_MAX ? url : null;
}

export interface DraftEditor {
  type: DraftType;
  channel: OutreachChannel;
  listingId: string;
  nudge: string;
  subject: string;
  body: string;
  /** Claude's original text — becomes `draftBody` on Mark sent. */
  draftBody: string | null;
  warning: string | null;
}

export function emptyEditor(type: DraftType, channel: OutreachChannel, listingId = ""): DraftEditor {
  return { type, channel, listingId, nudge: "", subject: "", body: "", draftBody: null, warning: null };
}

export function lengthNote(type: DraftType, body: string): { text: string; over: boolean } | null {
  if (type !== "CONNECT_NOTE") return null;
  return { text: `${body.length} / ${CONNECT_NOTE_MAX}`, over: body.length > CONNECT_NOTE_MAX };
}

/** The Log-message payload "Mark sent" sends: the edited text, and the draft it came from. */
export function markSentPayload(e: DraftEditor, sentAt: Date): MessageInputRaw & { draftBody: string | null } {
  return {
    direction: "OUT",
    type: e.type,
    channel: e.channel,
    subject: draftUsesSubject(e.type) && e.channel === "EMAIL" ? e.subject : "",
    body: e.body,
    sentAt: sentAt.toISOString(),
    listingId: e.listingId || null,
    draftBody: e.draftBody,
  };
}
