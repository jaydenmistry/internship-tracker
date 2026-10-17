import { z } from "zod";

/**
 * Your own font files for exported PDFs — Aptos, to match Word. A font can't
 * be committed (Aptos's licence forbids redistributing it, and the repo is
 * public), so you upload the .ttf once on /cover-letter/settings and it is
 * stored like the signature: one JSON row in `Setting`, separate from the
 * profile so the editor page doesn't carry a few hundred KB of font on every
 * load — it fetches them only when a PDF is built. Without one, PDFs use
 * Helvetica. Pure, so the editor and tests can import it.
 */

export const LETTER_FONTS_KEY = "coverletter.fonts";

/** Aptos is ~220 KB a weight; this leaves room for larger families. */
export const FONT_MAX_BYTES = 2 * 1024 * 1024;

export const FONT_WEIGHTS = ["regular", "bold"] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

export const FontFileSchema = z.object({
  /** From the font's own name table, e.g. "Aptos" — also the .docx font name. */
  family: z.string().min(1).max(64),
  style: z.string().max(64),
  base64: z
    .string()
    .min(1)
    .max(Math.ceil((FONT_MAX_BYTES * 4) / 3) + 4)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});

export type FontFile = z.infer<typeof FontFileSchema>;

export const LetterFontsSchema = z.object({
  regular: FontFileSchema.nullable().default(null),
  /** For your name in the letterhead; without it the regular face is emboldened. */
  bold: FontFileSchema.nullable().default(null),
});

export type LetterFonts = z.infer<typeof LetterFontsSchema>;

export const NO_LETTER_FONTS: LetterFonts = { regular: null, bold: null };

/** One bad entry falls back to none instead of losing the other. */
export function parseLetterFonts(raw: unknown): LetterFonts {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return NO_LETTER_FONTS;
  const source = raw as Record<string, unknown>;
  const pick = (key: FontWeight) => {
    const parsed = FontFileSchema.safeParse(source[key]);
    return parsed.success ? parsed.data : null;
  };
  return { regular: pick("regular"), bold: pick("bold") };
}

/** What the pages show about the uploaded fonts — names only, never the bytes. */
export type LetterFontsInfo = Record<FontWeight, { family: string; style: string } | null>;

export function letterFontsInfo(fonts: LetterFonts): LetterFontsInfo {
  const info = (f: FontFile | null) => (f ? { family: f.family, style: f.style } : null);
  return { regular: info(fonts.regular), bold: info(fonts.bold) };
}

/** The font family the .docx asks Word for: your uploaded font's, else Aptos. */
export function docxFontFamily(info: LetterFontsInfo): string {
  return info.regular?.family ?? "Aptos";
}
