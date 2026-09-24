import { z } from "zod";
import type { ContactKind, ContactStatus } from "@/generated/prisma/enums";

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
