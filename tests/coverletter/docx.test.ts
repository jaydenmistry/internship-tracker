import { describe, expect, it } from "vitest";
import { composeLetter } from "@/lib/coverletter/compose";
import { buildDocx, crc32, documentXml, headerXml, signatureExtent, xmlText, zipStored } from "@/lib/coverletter/docx";
import { DEFAULT_LETTER_PROFILE, type LetterProfile } from "@/lib/coverletter/profile-schema";
import { readZip } from "./read-zip";

/**
 * The hand-rolled .docx writer: CRC, ZIP layout, and the WordprocessingML it
 * emits for the letter template. A broken file here means a cover letter
 * Word refuses to open.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** 1×1 PNG. */
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const text = (files: Map<string, Uint8Array>, name: string) => dec.decode(files.get(name));

const profile: LetterProfile = {
  ...DEFAULT_LETTER_PROFILE,
  name: "Jayden Mistry",
  contactLines: ["Atlanta, GA | 555-0100 | me@example.com", "example.com | github.com/me"],
};

const letter = (p: LetterProfile = profile, body = "First paragraph.\n\nSecond & last <one>.") =>
  composeLetter({ profile: p, company: "MEMX", recipient: null, greeting: null, body, date: "2026-10-13" });

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(enc.encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe("zipStored", () => {
  it("round-trips names and contents, including UTF-8", () => {
    const files = readZip(
      zipStored([
        { name: "a.txt", data: enc.encode("hello") },
        { name: "dir/é.xml", data: enc.encode("<x>ü</x>") },
      ]),
    );
    expect([...files.keys()]).toEqual(["a.txt", "dir/é.xml"]);
    expect(text(files, "dir/é.xml")).toBe("<x>ü</x>");
  });
});

describe("xmlText", () => {
  it("escapes markup and drops characters XML forbids", () => {
    expect(xmlText('R&D <Labs> "x"\u0000\u0007ok')).toBe("R&amp;D &lt;Labs&gt; &quot;x&quot;ok");
  });
});

describe("documentXml", () => {
  const xml = documentXml(letter(), { header: "rIdHeader", signature: null });

  it("lays the letter out in template order", () => {
    const order = ["October 13, 2026", "Talent Acquisition Team", "MEMX", "Dear MEMX Talent Acquisition Team,", "First paragraph.", "Sincerely,", "Jayden Mistry"];
    const positions = order.map((s) => xml.indexOf(`>${s.replace("&", "&amp;")}<`));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("indents body paragraphs half an inch and uses the template's sizes", () => {
    expect(xml.match(/<w:ind w:firstLine="720"\/>/g)).toHaveLength(2);
    expect(xml).toContain('<w:sz w:val="21"/>'); // 10.5 pt body
    expect(xml).toContain('<w:sz w:val="18"/>'); // 9 pt date and sign-off
    expect(xml).toContain('w:ascii="Aptos"');
  });

  it("escapes the letter's text", () => {
    expect(xml).toContain("Second &amp; last &lt;one&gt;.");
    expect(xml).not.toContain("<one>");
  });

  it("references the header and keeps 1-inch margins on US Letter", () => {
    expect(xml).toContain('<w:headerReference w:type="default" r:id="rIdHeader"/>');
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"/>');
    expect(xml).toContain('w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"');
  });
});

describe("headerXml", () => {
  it("puts the name in bold capitals over centred contact lines", () => {
    const xml = headerXml(letter().header!);
    expect(xml).toContain(">JAYDEN MISTRY<");
    expect(xml).toContain("<w:b/>");
    expect(xml.match(/<w:jc w:val="center"\/>/g)).toHaveLength(3);
    expect(xml).toContain(">example.com | github.com/me<");
  });
});

describe("signatureExtent", () => {
  it("keeps the aspect ratio at a fixed width, capping very tall images", () => {
    expect(signatureExtent({ width: 442, height: 118 })).toEqual({ cx: 1_800_225, cy: Math.round((1_800_225 * 118) / 442) });
    const tall = signatureExtent({ width: 100, height: 100 });
    expect(tall.cy).toBe(685_800);
    expect(tall.cx).toBe(685_800);
    const wide = signatureExtent({ width: 4000, height: 10 });
    expect(wide.cx).toBe(1_800_225);
    expect(wide.cy).toBe(4501);
  });
});

describe("buildDocx", () => {
  it("packages the document, its header and the signature image", () => {
    const withSig = letter({ ...profile, signature: { mime: "image/png", base64: PNG_1X1, width: 1, height: 1 } });
    const files = readZip(buildDocx(withSig));
    expect([...files.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
      "word/header1.xml",
      "word/media/signature.png",
    ]);
    expect(text(files, "[Content_Types].xml")).toContain('PartName="/word/header1.xml"');
    expect(text(files, "word/_rels/document.xml.rels")).toContain('Id="rIdSignature"');
    expect(text(files, "word/document.xml")).toContain('<a:blip r:embed="rIdSignature"/>');
    expect([...files.get("word/media/signature.png")!.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
  });

  it("leaves out the header and image when the profile has neither", () => {
    const files = readZip(buildDocx(letter(DEFAULT_LETTER_PROFILE)));
    expect(files.has("word/header1.xml")).toBe(false);
    expect([...files.keys()].some((k) => k.startsWith("word/media/"))).toBe(false);
    expect(text(files, "word/document.xml")).not.toContain("headerReference");
  });

  it("is deterministic", () => {
    expect(buildDocx(letter())).toEqual(buildDocx(letter()));
  });
});
