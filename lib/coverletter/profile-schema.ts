import { z } from "zod";

/**
 * Your letterhead and sign-off for exported cover letters: name, contact
 * lines, closing, default recipient and greeting, and a signature image.
 * Stored as one JSON row in `Setting` (never in the repo — it's personal
 * contact data) and edited on /cover-letter/settings. Pure, so the editor and
 * tests can import the defaults.
 */

export const LETTER_PROFILE_KEY = "coverletter.profile";

/** Signature images are small scans; this keeps the Setting row small too. */
export const SIGNATURE_MAX_BYTES = 512 * 1024;

export const SignatureSchema = z.object({
  mime: z.enum(["image/png", "image/jpeg"]),
  /** Base64 of the image bytes. */
  base64: z
    .string()
    .min(1)
    .max(Math.ceil((SIGNATURE_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
  width: z.number().int().positive().max(4000),
  height: z.number().int().positive().max(4000),
});

export type Signature = z.infer<typeof SignatureSchema>;

export const LetterProfileSchema = z.object({
  /** "Jayden Mistry" — shown in capitals in the letterhead, as-is under the signature. */
  name: z.string().trim().max(100).default(""),
  /** Up to three centred lines under the name: location, phone, email, links. */
  contactLines: z.array(z.string().trim().max(200)).max(3).default([]),
  closing: z.string().trim().min(1).max(60).default("Sincerely,"),
  /** First line of the recipient block; the company name goes under it. */
  recipient: z.string().trim().max(100).default("Talent Acquisition Team"),
  /** `{company}` is replaced with the company name. */
  greeting: z.string().trim().min(1).max(200).default("Dear {company} Talent Acquisition Team,"),
  signature: SignatureSchema.nullable().default(null),
});

export type LetterProfile = z.infer<typeof LetterProfileSchema>;

export const DEFAULT_LETTER_PROFILE: LetterProfile = LetterProfileSchema.parse({});

/** One bad field falls back to its default instead of losing the rest. */
export function parseLetterProfile(raw: unknown): LetterProfile {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_LETTER_PROFILE;
  const source = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { ...DEFAULT_LETTER_PROFILE };
  for (const key of Object.keys(LetterProfileSchema.shape) as (keyof LetterProfile)[]) {
    if (source[key] === undefined) continue;
    const parsed = LetterProfileSchema.shape[key].safeParse(source[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as LetterProfile;
}

/** The profile minus the image bytes, for forms that don't need them. */
export type LetterProfileFields = Omit<LetterProfile, "signature">;
