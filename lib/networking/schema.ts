import { z } from "zod";
import type {
  ContactKind,
  ContactStatus,
  OutreachChannel,
  OutreachDirection,
  OutreachType,
} from "@/generated/prisma/enums";

/**
 * Contact input rules and labels, shared by the Server Actions and the /network
 * UI. Pure and Prisma-free so client components can import it: the enum
 * VALUES are spelled out here, and `satisfies` keeps them in lockstep with the
 * generated Prisma enums.
 */

export const CONTACT_KINDS = [
  "RECRUITER",
  "ENGINEER",
  "HIRING_MANAGER",
  "ALUMNI",
  "OTHER",
] as const satisfies readonly ContactKind[];

export const CONTACT_STATUSES = [
  "NOT_CONTACTED",
  "PENDING_CONNECTION",
  "AWAITING_REPLY",
  "REPLIED",
  "CHATTED",
  "REFERRED",
  "COLD",
] as const satisfies readonly ContactStatus[];

export const KIND_LABELS: Record<ContactKind, string> = {
  RECRUITER: "recruiter",
  ENGINEER: "engineer",
  HIRING_MANAGER: "hiring manager",
  ALUMNI: "alumni",
  OTHER: "other",
};

export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  NOT_CONTACTED: "not contacted",
  PENDING_CONNECTION: "pending connection",
  AWAITING_REPLY: "awaiting reply",
  REPLIED: "replied",
  CHATTED: "chatted",
  REFERRED: "referred",
  COLD: "cold",
};

/** Text colour per status — the same tokens the tracker uses. */
export const CONTACT_STATUS_TONE: Record<ContactStatus, string> = {
  NOT_CONTACTED: "text-faint",
  PENDING_CONNECTION: "text-dim",
  AWAITING_REPLY: "text-accent",
  REPLIED: "text-info",
  CHATTED: "text-info",
  REFERRED: "text-ok",
  COLD: "text-faint",
};

export const CONTACT_LIMITS = {
  name: 200,
  company: 200,
  title: 200,
  email: 320,
  linkedinUrl: 500,
  howMet: 500,
  notes: 20_000,
} as const;

/**
 * An https URL on linkedin.com or a subdomain of it, normalized through the URL
 * parser. Anything else is rejected: this is rendered as an `href`, and a
 * `javascript:` value there is the XSS vector React does not escape.
 */
export function parseLinkedinUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (host !== "linkedin.com" && !host.endsWith(".linkedin.com")) return null;
  if (url.username || url.password) return null;
  return url.href;
}

/** Trimmed text, blank → null, capped at `max`. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max, `limited to ${max} characters`)
    .transform((s) => (s.trim() === "" ? null : s.trim()))
    .nullable()
    .optional()
    .transform((s) => s ?? null);

export const contactInputSchema = z.object({
  name: z
    .string()
    .max(CONTACT_LIMITS.name)
    .transform((s) => s.trim())
    .pipe(z.string().min(1, "a name is required")),
  company: optionalText(CONTACT_LIMITS.company),
  title: optionalText(CONTACT_LIMITS.title),
  kind: z.enum(CONTACT_KINDS),
  email: optionalText(CONTACT_LIMITS.email).pipe(
    z.email("not a valid email address").nullable(),
  ),
  linkedinUrl: optionalText(CONTACT_LIMITS.linkedinUrl).transform((s, ctx) => {
    if (s === null) return null;
    const parsed = parseLinkedinUrl(s);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "must be an https://…linkedin.com URL" });
      return z.NEVER;
    }
    return parsed;
  }),
  howMet: optionalText(CONTACT_LIMITS.howMet),
  // Notes keep their own whitespace (line breaks matter); only blank → null.
  notes: z
    .string()
    .max(CONTACT_LIMITS.notes, `limited to ${CONTACT_LIMITS.notes} characters`)
    .nullable()
    .optional()
    .transform((s) => (s == null || s.trim() === "" ? null : s)),
  doNotContact: z.boolean(),
});

/** What a Server Action receives (raw form values). */
export type ContactInputRaw = z.input<typeof contactInputSchema>;
/** What the data layer stores. */
export type ContactInput = z.output<typeof contactInputSchema>;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------


export const OUTREACH_TYPES = [
  "COLD",
  "CONNECT_NOTE",
  "ACCEPTED",
  "MEETING",
  "FOLLOW_UP",
  "THANK_YOU",
  "REFERRAL_ASK",
  "REPLY",
] as const satisfies readonly OutreachType[];

export const OUTREACH_CHANNELS = ["EMAIL", "LINKEDIN", "IN_PERSON", "OTHER"] as const satisfies readonly OutreachChannel[];
export const OUTREACH_DIRECTIONS = ["OUT", "IN"] as const satisfies readonly OutreachDirection[];

export const CHANNEL_LABELS: Record<OutreachChannel, string> = {
  EMAIL: "email",
  LINKEDIN: "LinkedIn",
  IN_PERSON: "in person",
  OTHER: "other",
};

/**
 * Which (direction, type) pairs are real events, and the channels each may
 * use. Anything outside this table is rejected at the boundary, so the
 * follow-up engine never has to reason about "an inbound cold email".
 */
export const MESSAGE_RULES: Record<
  OutreachDirection,
  Partial<Record<OutreachType, readonly OutreachChannel[]>>
> = {
  OUT: {
    // Openers are EMAIL or LINKEDIN only: those are the channels the
    // follow-up engine runs a cadence for (isOpener in followup.ts). Offering
    // OTHER here would log an "opener" that silently schedules nothing.
    COLD: ["EMAIL", "LINKEDIN"],
    CONNECT_NOTE: ["LINKEDIN"],
    MEETING: ["IN_PERSON", "OTHER"],
    FOLLOW_UP: ["EMAIL", "LINKEDIN", "OTHER"],
    THANK_YOU: ["EMAIL", "LINKEDIN", "OTHER"],
    REFERRAL_ASK: ["EMAIL", "LINKEDIN"],
    REPLY: ["EMAIL", "LINKEDIN", "IN_PERSON", "OTHER"],
  },
  IN: {
    ACCEPTED: ["LINKEDIN"],
    REPLY: ["EMAIL", "LINKEDIN", "IN_PERSON", "OTHER"],
  },
};

/** How each event reads in the timeline and the Log message picker. */
export function eventLabel(direction: OutreachDirection, type: OutreachType): string {
  if (direction === "IN") return type === "ACCEPTED" ? "They accepted your connection" : "They replied";
  switch (type) {
    case "COLD":
      return "You sent an opener";
    case "CONNECT_NOTE":
      return "You sent a connection note";
    case "MEETING":
      return "You met";
    case "FOLLOW_UP":
      return "You followed up";
    case "THANK_YOU":
      return "You sent a thank-you";
    case "REFERRAL_ASK":
      return "You asked for a referral";
    default:
      return "You replied";
  }
}

export const MESSAGE_LIMITS = { subject: 300, body: 20_000 } as const;

/** A message may be dated up to a day ahead (zone slop), never further. */
const MAX_FUTURE_MS = 86_400_000;

const sentAtSchema = z.iso
  .datetime({ offset: true })
  .transform((s) => new Date(s))
  .refine((d) => d.getTime() <= Date.now() + MAX_FUTURE_MS, "can't be in the future");

export const messageInputSchema = z
  .object({
    direction: z.enum(OUTREACH_DIRECTIONS),
    type: z.enum(OUTREACH_TYPES),
    channel: z.enum(OUTREACH_CHANNELS),
    subject: optionalText(MESSAGE_LIMITS.subject),
    // Bodies keep their own whitespace; empty is fine (an acceptance, a meeting).
    body: z.string().max(MESSAGE_LIMITS.body, `limited to ${MESSAGE_LIMITS.body} characters`).default(""),
    sentAt: sentAtSchema,
    listingId: z.string().min(1).max(100).nullable().optional().transform((s) => s ?? null),
    /** Claude's original draft, when this message started as one (phase 3). */
    draftBody: z
      .string()
      .max(MESSAGE_LIMITS.body)
      .nullable()
      .optional()
      .transform((s) => (s == null || s.trim() === "" ? null : s)),
  })
  .superRefine((m, ctx) => {
    const channels = MESSAGE_RULES[m.direction][m.type];
    if (!channels) {
      ctx.addIssue({ code: "custom", path: ["type"], message: `${m.direction} ${m.type} isn't a message you can log` });
    } else if (!channels.includes(m.channel)) {
      ctx.addIssue({ code: "custom", path: ["channel"], message: `${m.type} can't be sent by ${m.channel}` });
    }
  });

export type MessageInputRaw = z.input<typeof messageInputSchema>;
export type MessageInput = z.output<typeof messageInputSchema>;

/** Editing a logged message: its words and its date, never its kind. */
export const messageEditSchema = z.object({
  subject: optionalText(MESSAGE_LIMITS.subject),
  body: z.string().max(MESSAGE_LIMITS.body, `limited to ${MESSAGE_LIMITS.body} characters`),
  sentAt: sentAtSchema,
});
export type MessageEdit = z.output<typeof messageEditSchema>;
