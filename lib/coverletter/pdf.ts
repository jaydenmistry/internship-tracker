import {
  PDFDocument,
  StandardFonts,
  TextRenderingMode,
  popGraphicsState,
  pushGraphicsState,
  setLineWidth,
  setTextRenderingMode,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type { LetterDoc } from "./compose";
import { signatureExtent } from "./docx";
import { base64ToBytes } from "./image";

/**
 * The exported letter as a PDF, laid out the way Word lays out the .docx
 * (lib/coverletter/docx.ts) — measured against a letter Word exported: 10 pt
 * text and a 14 pt bold name, 1.15 line spacing, the same paragraph spacing,
 * indent, margins and header, on US Letter. Built in the browser with
 * pdf-lib so the download is one click with the right file name.
 *
 * The font is the one you uploaded on /cover-letter/settings (Aptos, to
 * match Word), embedded as a subset; a bold face is optional — without it the
 * name is emboldened by outlining the regular one. With no upload it is
 * Helvetica, a PDF standard font every reader has built in, which covers
 * Windows-1252 only. Characters a font lacks (rare in a letter: CJK, emoji)
 * are swapped for their nearest plain form or "?" rather than failing.
 */

const PT_PER_TWIP = 1 / 20;
const PAGE = { width: 612, height: 792 };
const MARGIN = { top: 72, side: 72, bottom: 72, header: 708 * PT_PER_TWIP };
const SPACED = 1.15; // w:line="276"
const SIZE = { name: 14, text: 10 } as const;
/** Space after, in twips, as in the .docx. */
const AFTER = { header: 40, headerLast: 320, date: 320, para: 80, signature: 60 } as const;
/** Word starts the body this far below a header that runs past the top
 *  margin (measured: Word's export puts the date 11.8 pt lower than the
 *  header's own spacing accounts for). */
const BELOW_HEADER = 11.8;
const FIRST_LINE_INDENT = 36;

/** A font and the vertical metrics Word lays its lines out with, per point of size. */
interface Face {
  font: PDFFont;
  /** Baseline below the top of the line. */
  ascent: number;
  /** Single line height, before the 1.15 spacing. */
  height: number;
  /** Draw outlined as well as filled — a bold for a family uploaded without one. */
  embolden?: boolean;
  /** Code points the font has glyphs for; null for a standard font (WinAnsi). */
  charset: ReadonlySet<number> | null;
}

/** Helvetica has Arial's widths; Word lays Arial out at these metrics. */
const HELVETICA_METRICS = { ascent: 0.905, height: 1.15 };

interface Style {
  face: Face;
  size: number;
  after: number; // twips
  center?: boolean;
  firstLine?: number; // points
}

class Writer {
  private page!: PDFPage;
  private y = 0;
  private readonly safe = new Map<string, string>();

  constructor(
    private readonly pdf: PDFDocument,
    private readonly drawHeader: (writer: Writer) => void,
  ) {
    this.newPage();
  }

  newPage() {
    this.page = this.pdf.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN.header;
    this.drawHeader(this);
    // Body starts at the top margin, or below a header taller than it.
    this.y = Math.min(PAGE.height - MARGIN.top, this.y - (this.y < PAGE.height - MARGIN.header ? BELOW_HEADER : 0));
  }

  /** Header lines are drawn from the header distance, not the margin, and
   *  wrap (each piece centred) the way Word wraps them in the .docx. */
  headerLine(text: string, style: Style) {
    const lines = wrap(this.clean(text, style.face), style.face.font, style.size, PAGE.width - 2 * MARGIN.side);
    this.writeLines(lines, style, false);
  }

  /** Text the face can draw; everything else simplified or "?". */
  clean(text: string, face: Face): string {
    let out = "";
    for (const ch of text.replace(/\t/g, " ")) {
      const key = `${face.font.name}:${ch}`;
      let ok = this.safe.get(key);
      if (ok === undefined) {
        ok = drawable(face, ch) ? ch : simplify(face, ch);
        this.safe.set(key, ok);
      }
      out += ok;
    }
    return out;
  }

  paragraph(text: string, style: Style) {
    const width = PAGE.width - 2 * MARGIN.side;
    const lines: string[] = [];
    text.split("\n").forEach((segment, i) => {
      const indent = i === 0 ? (style.firstLine ?? 0) : 0;
      lines.push(...wrap(this.clean(segment, style.face), style.face.font, style.size, width, indent));
    });
    this.writeLines(lines.length ? lines : [""], style, true);
  }

  private writeLines(lines: string[], style: Style, canBreak: boolean) {
    const { face, size } = style;
    const lineHeight = size * face.height * SPACED;
    lines.forEach((line, i) => {
      if (canBreak && this.y - lineHeight < MARGIN.bottom) this.newPage();
      // Word puts the extra 0.15 below the text, so the baseline sits one ascent down.
      const baseline = this.y - size * face.ascent;
      const indent = i === 0 ? (style.firstLine ?? 0) : 0;
      const x = style.center ? (PAGE.width - face.font.widthOfTextAtSize(line, size)) / 2 : MARGIN.side + indent;
      if (line) this.text(line, x, baseline, style);
      this.y -= lineHeight;
    });
    this.y -= style.after * PT_PER_TWIP;
  }

  private text(line: string, x: number, y: number, { face, size }: Style) {
    if (!face.embolden) {
      this.page.drawText(line, { x, y, size, font: face.font });
      return;
    }
    this.page.pushOperators(
      pushGraphicsState(),
      setTextRenderingMode(TextRenderingMode.FillAndOutline),
      setLineWidth(size * 0.035),
    );
    this.page.drawText(line, { x, y, size, font: face.font });
    this.page.pushOperators(popGraphicsState());
  }

  image(img: PDFImage, widthPt: number, heightPt: number, afterTwips: number) {
    if (this.y - heightPt < MARGIN.bottom) this.newPage();
    this.page.drawImage(img, { x: MARGIN.side, y: this.y - heightPt, width: widthPt, height: heightPt });
    this.y -= heightPt + afterTwips * PT_PER_TWIP;
  }
}

function drawable(face: Face, ch: string): boolean {
  if (face.charset) return face.charset.has(ch.codePointAt(0)!);
  try {
    face.font.encodeText(ch);
    return true;
  } catch {
    return false;
  }
}

/** "é" stays if the font has it; "ő" → "o" when it doesn't; "→" → "?". */
function simplify(face: Face, ch: string): string {
  const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  if (base && base !== ch && [...base].every((c) => drawable(face, c))) return base;
  return "?";
}

/** Greedy word wrap; a word wider than a whole line is broken by character. */
export function wrap(text: string, font: PDFFont, size: number, width: number, firstIndent = 0): string[] {
  const words = text.split(/ +/).filter((w) => w !== "");
  if (words.length === 0) return [""];
  const lines: string[] = [];
  let line = "";
  let limit = width - firstIndent;
  const fits = (s: string) => font.widthOfTextAtSize(s, size) <= limit;

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (fits(candidate)) {
      line = candidate;
      continue;
    }
    if (line) {
      lines.push(line);
      limit = width;
      line = "";
    }
    if (fits(word)) {
      line = word;
      continue;
    }
    let chunk = "";
    for (const ch of word) {
      if (fits(chunk + ch)) chunk += ch;
      else {
        lines.push(chunk);
        limit = width;
        chunk = ch;
      }
    }
    line = chunk;
  }
  if (line) lines.push(line);
  return lines;
}

/** Your uploaded font files, as bytes. */
export interface PdfFonts {
  regular: Uint8Array;
  bold: Uint8Array | null;
}

interface OpenFont {
  unitsPerEm: number;
  ascent: number;
  descent: number;
  lineGap: number;
  "OS/2"?: unknown;
}

interface Os2Metrics {
  typoAscender?: number;
  typoDescender?: number;
  typoLineGap?: number;
  winAscent?: number;
  winDescent?: number;
  fsSelection?: { useTypoMetrics?: boolean };
}

/**
 * The line metrics Word uses for a font: the typographic ones when the font
 * asks for them (Aptos does), else the Windows ascent and descent.
 */
export function wordMetrics(font: OpenFont): { ascent: number; height: number } {
  const upm = font.unitsPerEm;
  const os2 = font["OS/2"] as Os2Metrics | undefined;
  if (os2?.fsSelection?.useTypoMetrics && os2.typoAscender !== undefined && os2.typoDescender !== undefined) {
    return {
      ascent: os2.typoAscender / upm,
      height: (os2.typoAscender - os2.typoDescender + (os2.typoLineGap ?? 0)) / upm,
    };
  }
  if (os2?.winAscent && os2.winDescent !== undefined) {
    return { ascent: os2.winAscent / upm, height: (os2.winAscent + os2.winDescent) / upm };
  }
  return { ascent: font.ascent / upm, height: (font.ascent - font.descent + font.lineGap) / upm };
}

async function faces(pdf: PDFDocument, fonts: PdfFonts | null | undefined): Promise<{ regular: Face; bold: Face }> {
  if (!fonts) {
    const standard = (font: PDFFont): Face => ({ font, ...HELVETICA_METRICS, charset: null });
    return {
      regular: standard(await pdf.embedFont(StandardFonts.Helvetica)),
      bold: standard(await pdf.embedFont(StandardFonts.HelveticaBold)),
    };
  }
  // Loaded only when there's a font to embed: fontkit is the bulk of the PDF code.
  const fontkit = (await import("@pdf-lib/fontkit")).default;
  pdf.registerFontkit(fontkit);
  const custom = async (bytes: Uint8Array): Promise<Face> => {
    const font = await pdf.embedFont(bytes, { subset: true });
    return { font, ...wordMetrics(fontkit.create(bytes) as unknown as OpenFont), charset: new Set(font.getCharacterSet()) };
  };
  const regular = await custom(fonts.regular);
  const bold = fonts.bold ? await custom(fonts.bold) : { ...regular, embolden: true };
  return { regular, bold };
}

export async function buildPdf(
  doc: LetterDoc,
  meta: { title: string; fonts?: PdfFonts | null },
): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title);
  if (doc.signName) pdf.setAuthor(doc.signName);
  pdf.setCreator("Internship Tracker");
  pdf.setProducer("Internship Tracker");

  const { regular, bold } = await faces(pdf, meta.fonts);

  const writer = new Writer(pdf, (w) => {
    if (!doc.header) return;
    const { name, lines } = doc.header;
    if (name) {
      w.headerLine(name, {
        face: bold,
        size: SIZE.name,
        center: true,
        after: lines.length ? AFTER.header : AFTER.headerLast,
      });
    }
    lines.forEach((line, i) =>
      w.headerLine(line, {
        face: regular,
        size: SIZE.text,
        center: true,
        after: i === lines.length - 1 ? AFTER.headerLast : AFTER.header,
      }),
    );
  });

  const text: Style = { face: regular, size: SIZE.text, after: AFTER.para };
  writer.paragraph(doc.date, { ...text, after: AFTER.date });
  for (const line of doc.recipient) writer.paragraph(line, text);
  writer.paragraph("", text);
  writer.paragraph(doc.greeting, text);
  writer.paragraph("", text);
  for (const p of doc.paragraphs) writer.paragraph(p, { ...text, firstLine: FIRST_LINE_INDENT });
  writer.paragraph("", text);
  writer.paragraph(doc.closing, text);

  if (doc.signature) {
    const bytes = base64ToBytes(doc.signature.base64);
    const img = doc.signature.mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const { cx, cy } = signatureExtent(doc.signature);
    writer.image(img, cx / 12_700, cy / 12_700, AFTER.signature);
  }
  if (doc.signName) writer.paragraph(doc.signName, { ...text, after: 0 });

  return new Uint8Array(await pdf.save());
}

export const PDF_MIME = "application/pdf";
