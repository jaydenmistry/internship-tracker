/**
 * Identifies an uploaded signature image from its bytes — never from the
 * browser-supplied type or file name — and reads its pixel size, which the
 * .docx needs for the picture's extent and the PDF for its aspect ratio.
 * PNG and baseline/extended/progressive JPEG only — lossless, hierarchical
 * and arithmetic-coded JPEGs aren't reliably drawn by PDF readers or Word.
 * Pure.
 */

/** Large enough for any scan of a signature; small enough that decoding it
 *  for the PDF can't exhaust the browser's memory. */
export const MAX_IMAGE_SIDE = 4000;

export interface ImageInfo {
  mime: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  // PNG: 8-byte signature, then the IHDR chunk with width/height.
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
    if (type !== "IHDR") return null;
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return sizeOk(width, height) ? { mime: "image/png", width, height } : null;
  }

  // JPEG: SOI, then walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= bytes.length) {
      if (bytes[at] !== 0xff) return null;
      const marker = bytes[at + 1];
      if (marker === 0xff) {
        at += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2; // markers without a length
        continue;
      }
      const length = (bytes[at + 2] << 8) | bytes[at + 3];
      if (length < 2) return null;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        // SOF0 baseline, SOF1 extended, SOF2 progressive; anything else is refused.
        if (marker > 0xc2) return null;
        if (at + 9 > bytes.length) return null;
        const height = (bytes[at + 5] << 8) | bytes[at + 6];
        const width = (bytes[at + 7] << 8) | bytes[at + 8];
        return sizeOk(width, height) ? { mime: "image/jpeg", width, height } : null;
      }
      if (marker === 0xda || marker === 0xd9) return null; // scan or end before any frame
      at += 2 + length;
    }
  }
  return null;
}

function sizeOk(width: number, height: number): boolean {
  return width > 0 && height > 0 && width <= MAX_IMAGE_SIDE && height <= MAX_IMAGE_SIDE;
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
