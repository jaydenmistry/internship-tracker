import { describe, expect, it } from "vitest";
import { validateSignature } from "@/lib/coverletter/signature";
import { SIGNATURE_MAX_BYTES } from "@/lib/coverletter/profile-schema";

/** Upload-time checks on the signature image: a file accepted here must export. */

const PNG_1X1 = Uint8Array.from(
  atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
  (c) => c.charCodeAt(0),
);

describe("validateSignature", () => {
  it("accepts a real PNG and returns it base64-encoded with its size", async () => {
    const res = await validateSignature(PNG_1X1);
    expect(res).toMatchObject({ ok: true, signature: { mime: "image/png", width: 1, height: 1 } });
    if (res.ok) expect(atob(res.signature.base64).length).toBe(PNG_1X1.length);
  });

  it("rejects empty, oversized and non-image files", async () => {
    expect(await validateSignature(new Uint8Array())).toEqual({ ok: false, message: "That file is empty." });
    expect((await validateSignature(new Uint8Array(SIGNATURE_MAX_BYTES + 1))).ok).toBe(false);
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');
    expect(await validateSignature(svg)).toMatchObject({ ok: false, message: expect.stringMatching(/PNG or JPEG/) });
  });

  it("rejects a JPEG that passes the sniff but that PDF export couldn't embed", async () => {
    // A frame header with nothing behind it: the sniff reads a size, pdf-lib can't use it.
    const truncated = Uint8Array.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x07]);
    expect(await validateSignature(truncated)).toMatchObject({ ok: false, message: expect.stringMatching(/can't be used in a PDF/) });
  });
});
