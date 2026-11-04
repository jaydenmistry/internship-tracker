import type { SourceAdapter } from "./types";
import { simplifyAdapter } from "./simplify";
import { internListAdapter } from "./intern-list";
import { jobBoardsAdapter } from "./job-boards";

/**
 * The adapter registry. Adding a source = one adapter file + one entry here.
 * Job boards run last: they discover new boards from the links the curated
 * sources just brought in, so a company's board is read the run it first appears.
 */
export const adapters: SourceAdapter[] = [simplifyAdapter, internListAdapter, jobBoardsAdapter];
