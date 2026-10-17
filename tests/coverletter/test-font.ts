import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Geist (SIL OFL) stands in for Aptos in the font tests. It ships inside
 * Next.js, so no font file is committed to the repo.
 */
export const GEIST = new Uint8Array(
  readFileSync(path.join(process.cwd(), "node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf")),
);
