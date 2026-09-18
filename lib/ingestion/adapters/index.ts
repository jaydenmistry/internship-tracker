import type { SourceAdapter } from "./types";
import { simplifyAdapter } from "./simplify";
import { internListAdapter } from "./intern-list";

/**
 * The adapter registry. Adding a source = one adapter file + one entry here.
 */
export const adapters: SourceAdapter[] = [simplifyAdapter, internListAdapter];
