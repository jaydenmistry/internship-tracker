import fontkit from "@pdf-lib/fontkit";
import { PDFDocument } from "pdf-lib";
import { prisma } from "@/lib/db";
import {
  FONT_MAX_BYTES,
  LETTER_FONTS_KEY,
  LetterFontsSchema,
  parseLetterFonts,
  type FontFile,
  type FontWeight,
  type LetterFonts,
} from "./fonts-schema";

/** Reads, writes and checks the uploaded letter fonts (one `Setting` row). */

export async function loadLetterFonts(): Promise<LetterFonts> {
  const row = await prisma.setting.findUnique({ where: { key: LETTER_FONTS_KEY } });
  return parseLetterFonts(row?.value);
}

/** Serializable, so uploads of both weights from two tabs can't drop one. */
export function saveLetterFont(weight: FontWeight, file: FontFile | null): Promise<LetterFonts> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.setting.findUnique({ where: { key: LETTER_FONTS_KEY } });
    const next = LetterFontsSchema.parse({ ...parseLetterFonts(row?.value), [weight]: file });
    await tx.setting.upsert({
      where: { key: LETTER_FONTS_KEY },
      create: { key: LETTER_FONTS_KEY, value: next },
      update: { value: next },
    });
    return next;
  }, { isolationLevel: "Serializable" });
}

/** The OS/2 fields read here; fontkit parses them, its type declarations omit them. */
interface Os2 {
  fsType?: { noEmbedding?: boolean; bitmapOnly?: boolean };
}

function tag(bytes: Uint8Array): string {
  return String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
}

/** A name from the font's own name table, made safe to show and to put in the .docx. */
function cleanName(name: unknown): string {
  return typeof name === "string"
    ? Array.from(name.replace(/[\p{Cc}\p{Cf}<>&"]+/gu, " ").replace(/\s+/g, " ").trim()).slice(0, 64).join("")
    : "";
}

/**
 * Checks an uploaded font end to end, at upload time rather than at the first
 * export: a single TrueType/OpenType font (sniffed from its bytes), whose
 * licence bits allow embedding, that covers basic Latin, and that pdf-lib can
 * actually embed and save.
 */
export async function validateFont(
  bytes: Uint8Array,
): Promise<{ ok: true; font: FontFile } | { ok: false; message: string }> {
  if (bytes.length === 0) return { ok: false, message: "That file is empty." };
  if (bytes.length > FONT_MAX_BYTES) {
    return { ok: false, message: `Font files must be under ${Math.round(FONT_MAX_BYTES / 1024 / 1024)} MB.` };
  }
  const kind = bytes.length >= 4 ? tag(bytes) : "";
  if (kind === "ttcf") return { ok: false, message: "That's a font collection (.ttc). Upload a single .ttf or .otf." };
  if (kind === "wOFF" || kind === "wOF2") return { ok: false, message: "That's a web font. Upload the .ttf or .otf." };
  if (kind !== "\x00\x01\x00\x00" && kind !== "true" && kind !== "OTTO") {
    return { ok: false, message: "Use a .ttf or .otf font file." };
  }

  let family: string;
  let style: string;
  try {
    const font = fontkit.create(Buffer.from(bytes));
    const fsType = (font["OS/2"] as Os2 | undefined)?.fsType;
    if (fsType?.noEmbedding || fsType?.bitmapOnly) {
      return { ok: false, message: "This font's licence doesn't allow embedding it in documents." };
    }
    for (let cp = 0x21; cp <= 0x7e; cp++) {
      if (!font.hasGlyphForCodePoint(cp)) return { ok: false, message: "That font doesn't cover basic Latin letters." };
    }
    family = cleanName(font.familyName);
    style = cleanName(font.subfamilyName);
  } catch {
    return { ok: false, message: "That font file can't be read." };
  }
  if (!family) return { ok: false, message: "That font has no family name." };

  try {
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);
    const embedded = await pdf.embedFont(bytes, { subset: true });
    pdf.addPage().drawText("Sincerely, The quick brown fox — 0123456789", { font: embedded, size: 10 });
    await pdf.save();
  } catch {
    return { ok: false, message: "That font can't be used in a PDF." };
  }
  return { ok: true, font: { family, style, base64: Buffer.from(bytes).toString("base64") } };
}
