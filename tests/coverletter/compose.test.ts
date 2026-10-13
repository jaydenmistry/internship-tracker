import { describe, expect, it } from "vitest";
import {
  composeLetter,
  defaultGreeting,
  defaultRecipient,
  exportFilename,
  formatLetterDate,
  isCivilDate,
  splitParagraphs,
  todayCivil,
} from "@/lib/coverletter/compose";
import { imageInfo } from "@/lib/coverletter/image";
import { DEFAULT_LETTER_PROFILE, parseLetterProfile } from "@/lib/coverletter/profile-schema";

/** The export model, file naming, dates, the letterhead profile and signature sniffing. */

describe("exportFilename", () => {
  it("follows YYYYMMDD_Cover Letter_COMPANY.ext", () => {
    expect(exportFilename("2026-10-13", "MEMX", "pdf")).toBe("20261013_Cover Letter_MEMX.pdf");
    expect(exportFilename("2026-10-13", "Goldman Sachs", "docx")).toBe("20261013_Cover Letter_Goldman Sachs.docx");
  });

  it("strips characters a file name can't hold", () => {
    expect(exportFilename("2026-01-02", 'R&D / "Labs": X?', "pdf")).toBe("20260102_Cover Letter_R&D Labs X.pdf");
    expect(exportFilename("2026-01-02", "  ", "pdf")).toBe("20260102_Cover Letter_Company.pdf");
  });

  it("strips invisible format characters that could disguise the name", () => {
    const rlo = String.fromCodePoint(0x202e);
    expect(exportFilename("2026-01-02", `Acme${rlo}fdp.exe`, "pdf")).toBe("20260102_Cover Letter_Acme fdp.exe.pdf");
    expect(exportFilename("2026-01-02", `Zero${String.fromCodePoint(0x200b)}Width`, "pdf")).toBe("20260102_Cover Letter_Zero Width.pdf");
  });

  it("cuts a long name by code point, never splitting an emoji", () => {
    const name = exportFilename("2026-01-02", "🚀".repeat(100), "pdf");
    expect(name).toBe(`20260102_Cover Letter_${"🚀".repeat(80)}.pdf`);
    expect(name.isWellFormed()).toBe(true);
  });
});

describe("dates", () => {
  it("formats a civil date the way the template does", () => {
    expect(formatLetterDate("2026-10-13")).toBe("October 13, 2026");
    expect(formatLetterDate("2027-01-05")).toBe("January 5, 2027");
  });

  it("validates civil dates", () => {
    expect(isCivilDate("2026-02-28")).toBe(true);
    expect(isCivilDate("2026-02-30")).toBe(false);
    expect(isCivilDate("10/13/2026")).toBe(false);
  });

  it("takes today in local time", () => {
    expect(todayCivil(new Date(2026, 9, 13, 23, 59))).toBe("2026-10-13");
  });
});

describe("composeLetter", () => {
  const profile = { ...DEFAULT_LETTER_PROFILE, name: "Jayden Mistry", contactLines: ["Atlanta, GA", ""] };

  it("fills the template from the profile's defaults", () => {
    const doc = composeLetter({ profile, company: "MEMX", recipient: null, greeting: null, body: "One.\n\nTwo.", date: "2026-10-13" });
    expect(doc).toMatchObject({
      header: { name: "JAYDEN MISTRY", lines: ["Atlanta, GA"] },
      date: "October 13, 2026",
      recipient: ["Talent Acquisition Team", "MEMX"],
      greeting: "Dear MEMX Talent Acquisition Team,",
      paragraphs: ["One.", "Two."],
      closing: "Sincerely,",
      signName: "Jayden Mistry",
    });
  });

  it("uses the letter's own recipient block and greeting when set", () => {
    const doc = composeLetter({
      profile,
      company: "MEMX",
      recipient: "Hiring Team\nMEMX\n382 NE 191st St\n\nMiami, FL 33179",
      greeting: "Dear Ms. Rivera,",
      body: "x",
      date: "2026-10-13",
    });
    expect(doc.recipient).toEqual(["Hiring Team", "MEMX", "382 NE 191st St", "Miami, FL 33179"]);
    expect(doc.greeting).toBe("Dear Ms. Rivera,");
  });

  it("has no letterhead when the profile is empty", () => {
    const doc = composeLetter({ profile: DEFAULT_LETTER_PROFILE, company: "X", recipient: null, greeting: null, body: "x", date: "2026-10-13" });
    expect(doc.header).toBeNull();
  });

  it("splits paragraphs on blank lines, keeping line breaks inside one", () => {
    expect(splitParagraphs("A\r\nstill A\n \nB\n\n\n\nC  ")).toEqual(["A\nstill A", "B", "C"]);
  });

  it("builds default greeting and recipient", () => {
    expect(defaultGreeting({ greeting: "Hello {company} team," }, " Stripe ")).toBe("Hello Stripe team,");
    expect(defaultRecipient({ recipient: "" }, "Stripe")).toBe("Stripe");
  });
});

describe("parseLetterProfile", () => {
  it("keeps good fields and defaults bad ones", () => {
    const p = parseLetterProfile({ name: "Jay", closing: "", contactLines: ["a", "b", "c", "d"], signature: { mime: "image/gif" } });
    expect(p.name).toBe("Jay");
    expect(p.closing).toBe("Sincerely,");
    expect(p.contactLines).toEqual([]);
    expect(p.signature).toBeNull();
    expect(parseLetterProfile("nonsense")).toEqual(DEFAULT_LETTER_PROFILE);
  });
});

describe("imageInfo", () => {
  it("reads a PNG's size from IHDR", () => {
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    expect(imageInfo(png)).toEqual({ mime: "image/png", width: 1, height: 1 });
  });

  it("walks JPEG segments to the frame header", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const sof0 = [0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x76, 0x01, 0xba, 0x03, ...new Array(9).fill(0)];
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, ...app0, ...sof0]))).toEqual({ mime: "image/jpeg", width: 442, height: 118 });
  });

  it("refuses lossless/arithmetic JPEGs and images too large to decode safely", () => {
    const app0 = [0xff, 0xe0, 0x00, 0x10, ...new Array(14).fill(0)];
    const frame = (marker: number, h: number, w: number) => [0xff, marker, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x03, ...new Array(9).fill(0)];
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, ...app0, ...frame(0xc3, 10, 10)]))).toBeNull(); // lossless
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, ...app0, ...frame(0xc9, 10, 10)]))).toBeNull(); // arithmetic
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, ...app0, ...frame(0xc2, 10, 10)]))?.mime).toBe("image/jpeg"); // progressive ok
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, ...app0, ...frame(0xc0, 4001, 10)]))).toBeNull();
    const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
    new DataView(png.buffer).setUint32(16, 20_000);
    expect(imageInfo(png)).toBeNull();
  });

  it("rejects anything else, whatever it claims to be", () => {
    expect(imageInfo(new TextEncoder().encode("<svg onload=alert(1)>"))).toBeNull();
    expect(imageInfo(Uint8Array.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBeNull();
    expect(imageInfo(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });
});
