// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { composeLetter } from "@/lib/coverletter/compose";
import { buildDocx } from "@/lib/coverletter/docx";
import { DEFAULT_LETTER_PROFILE, type LetterProfile } from "@/lib/coverletter/profile-schema";
import { readZip } from "./read-zip";

/** Every XML part of the .docx parses as well-formed XML, whatever text went in. */

const dec = new TextDecoder();
const text = (files: Map<string, Uint8Array>, name: string) => dec.decode(files.get(name));
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const profile: LetterProfile = { ...DEFAULT_LETTER_PROFILE, name: "Jayden Mistry" };

describe("well-formed XML", () => {
  it("parses every part, even with hostile text in every field", () => {
    const parser = new DOMParser();
    const hostile = `<w:p>]]>&amp;"' \u0001 \ud800 ${"\t"}tab`;
    const doc = composeLetter({
      profile: {
        ...profile,
        name: hostile,
        contactLines: [hostile],
        closing: hostile,
        signature: { mime: "image/png", base64: PNG_1X1, width: 1, height: 1 },
      },
      company: hostile,
      recipient: hostile,
      greeting: hostile,
      body: `${hostile}\n\n${hostile}`,
      date: "2026-10-13",
    });
    const files = readZip(buildDocx(doc));
    for (const [name, data] of files) {
      if (!name.endsWith(".xml") && !name.endsWith(".rels")) continue;
      const parsed = parser.parseFromString(dec.decode(data), "application/xml");
      expect(parsed.getElementsByTagName("parsererror"), name).toHaveLength(0);
    }
    expect(text(files, "word/document.xml")).toContain("<w:tab/>");
  });
});

