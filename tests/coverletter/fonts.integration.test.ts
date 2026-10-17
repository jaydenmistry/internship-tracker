import { beforeEach, describe, expect, it } from "vitest";
import { LETTER_FONTS_KEY } from "@/lib/coverletter/fonts-schema";
import { hasTestDatabase } from "../db-url";

/** The uploaded PDF fonts persist per weight, and removing one keeps the other. */
const hasDb = hasTestDatabase();

describe.skipIf(!hasDb)("letter fonts (integration)", () => {
  let prisma: (typeof import("@/lib/db"))["prisma"];
  let fonts: typeof import("@/lib/coverletter/fonts");

  const file = (family: string) => ({ family, style: "Regular", base64: "AAEAAA==" });

  beforeEach(async () => {
    ({ prisma } = await import("@/lib/db"));
    fonts = await import("@/lib/coverletter/fonts");
    await prisma.setting.deleteMany({ where: { key: LETTER_FONTS_KEY } });
  });

  it("starts empty, stores each weight, and removes one without touching the other", async () => {
    expect(await fonts.loadLetterFonts()).toEqual({ regular: null, bold: null });
    await fonts.saveLetterFont("regular", file("Aptos"));
    await fonts.saveLetterFont("bold", file("Aptos Bold"));
    expect(await fonts.loadLetterFonts()).toEqual({ regular: file("Aptos"), bold: file("Aptos Bold") });
    await fonts.saveLetterFont("bold", null);
    expect(await fonts.loadLetterFonts()).toEqual({ regular: file("Aptos"), bold: null });
  });
});
