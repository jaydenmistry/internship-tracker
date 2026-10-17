import type { LetterDoc } from "./compose";
import { base64ToBytes } from "./image";

/**
 * A minimal .docx writer for an exported cover letter, laid out like the
 * user's own Word template: a centred letterhead in the page header (14 pt
 * bold name), 10 pt Aptos throughout — or the family of the font you uploaded
 * for PDFs — with a half-inch first-line indent, 1" margins on US Letter, and
 * the signature image inline above the name. Pure and dependency-free, so the browser builds the file without
 * a round trip.
 *
 * A .docx is a ZIP of a few XML parts. Entries are STORED (no compression):
 * a one-page letter is a few KB either way, and it keeps this to a CRC and
 * some headers instead of a deflate implementation.
 */

/** XML-escapes text and drops characters XML 1.0 forbids outright. */
export function xmlText(s: string): string {
  return s
    .replace(/[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ---------------------------------------------------------------------------
// ZIP (stored entries only)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS date/time fields. A fixed date keeps the output deterministic. */
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

export function zipStored(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const local = new Uint8Array(30 + name.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, DOS_TIME, true);
    lv.setUint16(12, DOS_DATE, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, 30);
    local.set(file.data, 30 + name.length);
    locals.push(local);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, DOS_TIME, true);
    cv.setUint16(14, DOS_DATE, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    // extra, comment, disk, internal attrs, external attrs: all zero
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + end.length);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// WordprocessingML
// ---------------------------------------------------------------------------

const NS_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** Font sizes in half-points, as in the template. */
const SIZE = { name: 28, text: 20 } as const;

export const DEFAULT_DOCX_FONT = "Aptos";

/** The signature is drawn this wide (EMU, 914400 per inch), height by aspect. */
const SIGNATURE_WIDTH_EMU = 1_800_225;
const SIGNATURE_MAX_HEIGHT_EMU = 685_800;

function runProps(font: string, size: number, bold = false): string {
  const f = xmlText(font).replace(/"/g, "&quot;");
  return (
    `<w:rPr><w:rFonts w:ascii="${f}" w:hAnsi="${f}" w:eastAsia="${f}" w:cs="${f}"/>` +
    (bold ? "<w:b/><w:bCs/>" : "") +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`
  );
}

interface ParaOptions {
  font: string;
  size: number;
  after?: number;
  before?: number;
  /** 1.15 line spacing, as the template uses; off for the signature line. */
  line?: boolean;
  center?: boolean;
  firstLine?: number;
  bold?: boolean;
}

/** One paragraph; "\n" becomes a line break and "\t" a tab. Empty text is a blank line. */
function para(text: string, o: ParaOptions): string {
  const spacing =
    "<w:spacing" +
    (o.before !== undefined ? ` w:before="${o.before}"` : "") +
    (o.after !== undefined ? ` w:after="${o.after}"` : "") +
    (o.line === false ? "" : ' w:line="276" w:lineRule="auto"') +
    "/>";
  const pPr =
    `<w:pPr>${spacing}` +
    (o.firstLine ? `<w:ind w:firstLine="${o.firstLine}"/>` : "") +
    (o.center ? '<w:jc w:val="center"/>' : "") +
    `${runProps(o.font, o.size, o.bold)}</w:pPr>`;
  const runs = text
    .split("\n")
    .map(
      (line, i) =>
        (i > 0 ? "<w:br/>" : "") +
        line
          .split("\t")
          .map((piece) => `<w:t xml:space="preserve">${xmlText(piece)}</w:t>`)
          .join("<w:tab/>"),
    )
    .join("");
  return `<w:p>${pPr}<w:r>${runProps(o.font, o.size, o.bold)}${runs}</w:r></w:p>`;
}

export function headerXml(header: NonNullable<LetterDoc["header"]>, font: string = DEFAULT_DOCX_FONT): string {
  const parts: string[] = [];
  if (header.name) {
    parts.push(para(header.name, { font, size: SIZE.name, bold: true, center: true, after: header.lines.length ? 40 : 320 }));
  }
  header.lines.forEach((line, i) =>
    parts.push(para(line, { font, size: SIZE.text, center: true, after: i === header.lines.length - 1 ? 320 : 40 })),
  );
  return `${XML_DECL}<w:hdr xmlns:w="${NS_W}" xmlns:r="${NS_R}">${parts.join("")}</w:hdr>`;
}

/** The signature's drawn size in EMU: fixed width, height by aspect, capped. */
export function signatureExtent(sig: { width: number; height: number }): { cx: number; cy: number } {
  let cx = SIGNATURE_WIDTH_EMU;
  let cy = Math.round((cx * sig.height) / sig.width);
  if (cy > SIGNATURE_MAX_HEIGHT_EMU) {
    cx = Math.round((cx * SIGNATURE_MAX_HEIGHT_EMU) / cy);
    cy = SIGNATURE_MAX_HEIGHT_EMU;
  }
  return { cx, cy };
}

function signatureXml(sig: NonNullable<LetterDoc["signature"]>, relId: string, font: string): string {
  const { cx, cy } = signatureExtent(sig);
  const drawing =
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:docPr id="1" name="Signature"/>' +
    `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS_A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic xmlns:a="${NS_A}"><a:graphicData uri="${NS_PIC}"><pic:pic xmlns:pic="${NS_PIC}">` +
    '<pic:nvPicPr><pic:cNvPr id="0" name="signature"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    "</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>";
  return (
    `<w:p><w:pPr><w:spacing w:before="0" w:after="60"/>${runProps(font, SIZE.text)}</w:pPr>` +
    `<w:r>${runProps(font, SIZE.text)}${drawing}</w:r></w:p>`
  );
}

export function documentXml(
  doc: LetterDoc,
  rel: { header: string | null; signature: string | null },
  font: string = DEFAULT_DOCX_FONT,
): string {
  const body = { font, size: SIZE.text, after: 80 };
  const parts: string[] = [];
  parts.push(para(doc.date, { ...body, after: 320 }));
  for (const line of doc.recipient) parts.push(para(line, body));
  parts.push(para("", body));
  parts.push(para(doc.greeting, body));
  parts.push(para("", body));
  for (const p of doc.paragraphs) parts.push(para(p, { ...body, firstLine: 720 }));
  parts.push(para("", body));
  parts.push(para(doc.closing, body));
  if (doc.signature && rel.signature) parts.push(signatureXml(doc.signature, rel.signature, font));
  if (doc.signName) parts.push(para(doc.signName, { font, size: SIZE.text }));

  const sect =
    "<w:sectPr>" +
    (rel.header ? `<w:headerReference w:type="default" r:id="${rel.header}"/>` : "") +
    '<w:pgSz w:w="12240" w:h="15840"/>' +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>' +
    "</w:sectPr>";
  return (
    `${XML_DECL}<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}">` +
    `<w:body>${parts.join("")}${sect}</w:body></w:document>`
  );
}

/** The letter as a .docx file's bytes; `font` is the family Word is asked for. */
export function buildDocx(doc: LetterDoc, opts: { font?: string } = {}): Uint8Array<ArrayBuffer> {
  const font = opts.font?.trim() || DEFAULT_DOCX_FONT;
  const enc = new TextEncoder();
  const sigExt = doc.signature?.mime === "image/png" ? "png" : "jpeg";
  const headerRel = doc.header ? "rIdHeader" : null;
  const sigRel = doc.signature ? "rIdSignature" : null;

  const contentTypes =
    `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="jpeg" ContentType="image/jpeg"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    (headerRel
      ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
      : "") +
    "</Types>";
  const rootRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="word/document.xml"/></Relationships>`;
  const docRels =
    `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    (headerRel ? `<Relationship Id="${headerRel}" Type="${NS_R}/header" Target="header1.xml"/>` : "") +
    (sigRel ? `<Relationship Id="${sigRel}" Type="${NS_R}/image" Target="media/signature.${sigExt}"/>` : "") +
    "</Relationships>";

  const files: Array<{ name: string; data: Uint8Array }> = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "word/document.xml", data: enc.encode(documentXml(doc, { header: headerRel, signature: sigRel }, font)) },
    { name: "word/_rels/document.xml.rels", data: enc.encode(docRels) },
  ];
  if (doc.header) files.push({ name: "word/header1.xml", data: enc.encode(headerXml(doc.header, font)) });
  if (doc.signature) {
    files.push({ name: `word/media/signature.${sigExt}`, data: base64ToBytes(doc.signature.base64) });
  }
  return zipStored(files);
}

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
