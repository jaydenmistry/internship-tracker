import { describe, expect, it } from "vitest";
import { validateFont } from "@/lib/coverletter/fonts";
import {
  FONT_MAX_BYTES,
  docxFontFamily,
  letterFontsInfo,
  parseLetterFonts,
} from "@/lib/coverletter/fonts-schema";
import { GEIST } from "./test-font";

/** Upload-time checks on PDF fonts: a file accepted here must embed. */

describe("validateFont", () => {
  it("accepts a real TrueType font and reads its names", async () => {
    const res = await validateFont(GEIST);
    expect(res).toMatchObject({ ok: true, font: { family: "Geist", style: "Regular" } });
    if (res.ok) expect(Buffer.from(res.font.base64, "base64").equals(Buffer.from(GEIST))).toBe(true);
  });

  it("rejects empty, oversized, collection, web-font and non-font files", async () => {
    const withTag = (t: string) => Uint8Array.from([...t].map((c) => c.charCodeAt(0)).concat(new Array(60).fill(0)));
    expect(await validateFont(new Uint8Array())).toEqual({ ok: false, message: "That file is empty." });
    expect((await validateFont(new Uint8Array(FONT_MAX_BYTES + 1))).ok).toBe(false);
    expect(await validateFont(withTag("ttcf"))).toMatchObject({ ok: false, message: expect.stringMatching(/collection/) });
    expect(await validateFont(withTag("wOF2"))).toMatchObject({ ok: false, message: expect.stringMatching(/web font/) });
    expect(await validateFont(new TextEncoder().encode("<svg/>"))).toMatchObject({ ok: false, message: expect.stringMatching(/\.ttf or \.otf/) });
  });

  it("rejects a file with a font's magic number but no font behind it", async () => {
    const fake = Uint8Array.from([0x00, 0x01, 0x00, 0x00, ...new Array(200).fill(7)]);
    expect((await validateFont(fake)).ok).toBe(false);
  });

  it("refuses a font whose licence bits forbid embedding", async () => {
    // fsType 0x0002 (restricted licence) patched into the OS/2 table.
    const bytes = GEIST.slice();
    const view = new DataView(bytes.buffer);
    const tables = view.getUint16(4);
    for (let i = 0; i < tables; i++) {
      const rec = 12 + i * 16;
      if (String.fromCharCode(...bytes.slice(rec, rec + 4)) === "OS/2") view.setUint16(view.getUint32(rec + 8) + 8, 0x0002);
    }
    expect(await validateFont(bytes)).toMatchObject({ ok: false, message: expect.stringMatching(/licence/) });
  });
});

describe("stored fonts", () => {
  const entry = { family: "Aptos", style: "Regular", base64: "AAEAAA==" };

  it("keeps a good entry when the other is malformed", () => {
    expect(parseLetterFonts({ regular: entry, bold: { family: "", base64: "!" } })).toEqual({ regular: entry, bold: null });
    expect(parseLetterFonts("nonsense")).toEqual({ regular: null, bold: null });
  });

  it("gives pages the names only, and Word the regular family or Aptos", () => {
    const info = letterFontsInfo({ regular: { ...entry, family: "Geist" }, bold: null });
    expect(info).toEqual({ regular: { family: "Geist", style: "Regular" }, bold: null });
    expect(JSON.stringify(info)).not.toContain("AAEAAA");
    expect(docxFontFamily(info)).toBe("Geist");
    expect(docxFontFamily({ regular: null, bold: null })).toBe("Aptos");
  });
});
