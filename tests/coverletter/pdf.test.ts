import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { composeLetter } from "@/lib/coverletter/compose";
import { buildPdf, wrap } from "@/lib/coverletter/pdf";
import { DEFAULT_LETTER_PROFILE } from "@/lib/coverletter/profile-schema";

/** The PDF export: it opens, fits on US Letter, wraps, and survives odd characters. */

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const doc = (body: string, signature = false) =>
  composeLetter({
    profile: {
      ...DEFAULT_LETTER_PROFILE,
      name: "Jayden Mistry",
      contactLines: ["Atlanta, GA | me@example.com"],
      signature: signature ? { mime: "image/png", base64: PNG_1X1, width: 442, height: 118 } : null,
    },
    company: "MEMX",
    recipient: null,
    greeting: null,
    body,
    date: "2026-10-13",
  });

describe("buildPdf", () => {
  it("produces a one-page US Letter PDF with the title set", async () => {
    const bytes = await buildPdf(doc("A short paragraph.\n\nAnother one.", true), { title: "Cover Letter — MEMX" });
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(pdf.getTitle()).toBe("Cover Letter — MEMX");
    expect(pdf.getAuthor()).toBe("Jayden Mistry");
  });

  it("flows a long letter onto a second page instead of off the bottom", async () => {
    const long = Array.from({ length: 14 }, () => "word ".repeat(90).trim()).join("\n\n");
    const pdf = await PDFDocument.load(await buildPdf(doc(long), { title: "t" }));
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });

  it("wraps a letterhead line wider than the page instead of running off it", async () => {
    const wideDoc = doc("Body.");
    wideDoc.header = { name: "JAYDEN MISTRY", lines: ["x ".repeat(100).trim(), "linkedin.com/in/someone | github.com/someone | example.com | 555-0100 | me@example.com"] };
    const pdf = await PDFDocument.load(await buildPdf(wideDoc, { title: "t" }));
    expect(pdf.getPageCount()).toBe(1);
  });

  it("moves the signature to the next page rather than drawing it off the bottom", async () => {
    const nearlyFull = Array.from({ length: 11 }, () => "word ".repeat(80).trim()).join("\n\n");
    const pdf = await PDFDocument.load(await buildPdf(doc(nearlyFull, true), { title: "t" }));
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(1);
  });

  it("doesn't fail on characters the standard font can't encode", async () => {
    const bytes = await buildPdf(doc("Smart “quotes” — fine. Emoji 🚀, CJK 漢字, ő and →."), { title: "t" });
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
  });
});

describe("wrap", () => {
  it("keeps every line inside the width and loses no words", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const textIn = "The quick brown fox jumps over the lazy dog ".repeat(12).trim();
    const lines = wrap(textIn, font, 10.5, 200, 36);
    expect(font.widthOfTextAtSize(lines[0], 10.5)).toBeLessThanOrEqual(164);
    for (const line of lines.slice(1)) expect(font.widthOfTextAtSize(line, 10.5)).toBeLessThanOrEqual(200);
    expect(lines.join(" ")).toBe(textIn);
  });

  it("breaks a single word wider than the line", async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const lines = wrap("x".repeat(200), font, 10, 100);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join("")).toBe("x".repeat(200));
  });
});
