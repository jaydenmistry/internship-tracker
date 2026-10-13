import { expect } from "vitest";
import { crc32 } from "@/lib/coverletter/docx";

const dec = new TextDecoder();

/** Reads a stored-only ZIP back through its central directory, checking every CRC. */
export function readZip(bytes: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  expect(view.getUint32(endAt, true)).toBe(0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(at, true)).toBe(0x02014b50);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = dec.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    expect(view.getUint32(localAt, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localAt + 26, true);
    const data = bytes.subarray(localAt + 30 + localNameLen, localAt + 30 + localNameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLen;
  }
  return out;
}

