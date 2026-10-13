import { PDFDocument, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "pdf-lib";
import type { LetterDoc } from "./compose";
import { signatureExtent } from "./docx";
import { base64ToBytes } from "./image";

/**
 * The exported letter as a PDF, laid out to match the .docx (lib/coverletter/
 * docx.ts): same sizes, spacing, indent, margins and header, on US Letter.
 * Built in the browser with pdf-lib so the download is one click with the
 * right file name.
 *
 * The font is Helvetica, one of the PDF standard fonts every reader has
 * built in — Aptos (the template's font) can't be bundled into the app. The
 * standard fonts cover Windows-1252 only, so anything outside it (rare in a
 * letter: CJK, emoji) is swapped for its nearest plain form or "?" rather
 * than failing the export.
 */

const PT_PER_TWIP = 1 / 20;
const PAGE = { width: 612, height: 792 };
const MARGIN = { top: 72, side: 72, bottom: 72, header: 708 * PT_PER_TWIP };
const LINE_FACTOR = 1.2; // a font's single line height relative to its size
const SPACED = 1.15; // w:line="276"
const SIZE = { name: 14, contact: 10, body: 10.5, small: 9 } as const;
const AFTER = { header: 40, headerLast: 320, date: 320, body: 80, small: 80, signature: 60 } as const;

interface Style {
  font: PDFFont;
  size: number;
  after: number; // twips
  before?: number; // twips
  spaced?: boolean;
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
    this.y = Math.min(this.y, PAGE.height - MARGIN.top);
  }

  /** Header lines are drawn from the header distance, not the margin, and
   *  wrap (each piece centred) the way Word wraps them in the .docx. */
  headerLine(text: string, style: Style) {
    const lines = wrap(this.clean(text, style.font), style.font, style.size, PAGE.width - 2 * MARGIN.side);
    this.writeLines(lines, style, false);
  }

  /** Text the standard fonts can encode; everything else simplified or "?". */
  clean(text: string, font: PDFFont): string {
    let out = "";
    for (const ch of text.replace(/\t/g, " ")) {
      const key = `${font.name}:${ch}`;
      let ok = this.safe.get(key);
      if (ok === undefined) {
        ok = encodable(font, ch) ? ch : simplify(font, ch);
        this.safe.set(key, ok);
      }
      out += ok;
    }
    return out;
  }

  paragraph(text: string, style: Style) {
    const width = PAGE.width - 2 * MARGIN.side;
    const lines: string[] = [];
    const hard = text.split("\n");
    hard.forEach((segment, i) => {
      const clean = this.clean(segment, style.font);
      const indent = i === 0 ? (style.firstLine ?? 0) : 0;
      lines.push(...wrap(clean, style.font, style.size, width, indent));
    });
    this.writeLines(lines.length ? lines : [""], style, true);
  }

  private writeLines(lines: string[], style: Style, canBreak: boolean) {
    const lineHeight = style.size * LINE_FACTOR * (style.spaced === false ? 1 : SPACED);
    if (style.before) this.y -= style.before * PT_PER_TWIP;
    lines.forEach((line, i) => {
      if (canBreak && this.y - lineHeight < MARGIN.bottom) this.newPage();
      const baseline = this.y - lineHeight + (lineHeight - style.size) / 2 + style.size * 0.22;
      const textWidth = style.font.widthOfTextAtSize(line, style.size);
      const indent = i === 0 ? (style.firstLine ?? 0) : 0;
      const x = style.center ? (PAGE.width - textWidth) / 2 : MARGIN.side + indent;
      if (line) this.page.drawText(line, { x, y: baseline, size: style.size, font: style.font });
      this.y -= lineHeight;
    });
    this.y -= style.after * PT_PER_TWIP;
  }

  image(img: PDFImage, widthPt: number, heightPt: number, beforeTwips: number, afterTwips: number) {
    this.y -= beforeTwips * PT_PER_TWIP;
    if (this.y - heightPt < MARGIN.bottom) this.newPage();
    this.page.drawImage(img, { x: MARGIN.side, y: this.y - heightPt, width: widthPt, height: heightPt });
    this.y -= heightPt + afterTwips * PT_PER_TWIP;
  }
}

function encodable(font: PDFFont, ch: string): boolean {
  try {
    font.encodeText(ch);
    return true;
  } catch {
    return false;
  }
}

/** "é" stays (it's in WinAnsi); "ő" → "o"; "→" → "?". */
function simplify(font: PDFFont, ch: string): string {
  const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  if (base && base !== ch && [...base].every((c) => encodable(font, c))) return base;
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

export async function buildPdf(doc: LetterDoc, meta: { title: string }): Promise<Uint8Array<ArrayBuffer>> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(meta.title);
  if (doc.signName) pdf.setAuthor(doc.signName);
  pdf.setCreator("Internship Tracker");
  pdf.setProducer("Internship Tracker");

  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const writer = new Writer(pdf, (w) => {
    if (!doc.header) return;
    const { name, lines } = doc.header;
    if (name) {
      w.headerLine(name, {
        font: bold,
        size: SIZE.name,
        center: true,
        after: lines.length ? AFTER.header : AFTER.headerLast,
      });
    }
    lines.forEach((line, i) =>
      w.headerLine(line, {
        font: regular,
        size: SIZE.contact,
        center: true,
        after: i === lines.length - 1 ? AFTER.headerLast : AFTER.header,
      }),
    );
  });

  const body: Style = { font: regular, size: SIZE.body, after: AFTER.body };
  writer.paragraph(doc.date, { font: regular, size: SIZE.small, after: AFTER.date });
  for (const line of doc.recipient) writer.paragraph(line, body);
  writer.paragraph("", body);
  writer.paragraph(doc.greeting, body);
  writer.paragraph("", body);
  for (const p of doc.paragraphs) writer.paragraph(p, { ...body, firstLine: 36 });
  writer.paragraph("", body);
  writer.paragraph(doc.closing, { font: regular, size: SIZE.small, after: AFTER.small });

  if (doc.signature) {
    const bytes = base64ToBytes(doc.signature.base64);
    const img = doc.signature.mime === "image/png" ? await pdf.embedPng(bytes) : await pdf.embedJpg(bytes);
    const { cx, cy } = signatureExtent(doc.signature);
    writer.image(img, cx / 12_700, cy / 12_700, AFTER.signature, AFTER.signature);
  }
  if (doc.signName) writer.paragraph(doc.signName, { font: regular, size: SIZE.small, after: 0 });

  return new Uint8Array(await pdf.save());
}

export const PDF_MIME = "application/pdf";
