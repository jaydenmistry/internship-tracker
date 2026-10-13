import type { Prisma } from "@/generated/prisma/client";
import type { AppStatus } from "@/generated/prisma/enums";
import { qualifiedTable } from "@/lib/sql";

/**
 * When a "not applied" Application row must be kept.
 *
 * "Not applied" is normally no row at all. A NOT_APPLIED row exists only to
 * hold user content written before applying — notes, or a cover letter — so
 * every path that would drop such a row (un-applying, clearing notes, a bulk
 * import saying "not applied") asks this first. Losing a letter you spent
 * twenty minutes editing because you toggled a status would be the worst
 * possible side effect.
 *
 * The predicate is pure; `dropApplicationIfEmpty` imports the client lazily
 * so importing this module needs no database.
 */

/** Select this alongside a row to call `holdsUserContent` on it. */
export const USER_CONTENT_SELECT = { notes: true, coverLetter: { select: { id: true } } } as const;

export function holdsUserContent(app: {
  notes: string | null;
  coverLetter: { id: string } | null;
}): boolean {
  return (typeof app.notes === "string" && app.notes.trim() !== "") || app.coverLetter !== null;
}

type Tx = Prisma.TransactionClient;

/** Takes the row lock that `dropApplicationIfEmpty` relies on. */
export async function lockApplication(tx: Tx, applicationId: string): Promise<void> {
  await tx.$queryRawUnsafe(`SELECT id FROM ${qualifiedTable("Application")} WHERE id = $1 FOR UPDATE`, applicationId);
}

export interface DropOptions {
  /** The caller is clearing the notes anyway (only a letter keeps the row). */
  ignoreNotes?: boolean;
  /** Drop only if the row still has this status under the lock — a row moved
   *  to APPLIED in another tab meanwhile must keep its history. */
  requireStatus?: AppStatus;
  /** Run inside the caller's transaction (which must already hold the lock
   *  or be about to take it here). */
  tx?: Tx;
}

/**
 * Deletes a row (its StatusEvents cascade) only if it holds no user content,
 * checked again under a row lock in the same transaction — so a letter or a
 * note saved a moment after the caller looked can't be cascaded away.
 * Inserting a CoverLetter takes a key-share lock on its Application, which
 * conflicts with FOR UPDATE, so the two can't interleave; a notes update
 * waits on the same row lock.
 *
 * Returns true when the row is gone, false when it was kept.
 */
export async function dropApplicationIfEmpty(applicationId: string, opts: DropOptions = {}): Promise<boolean> {
  const run = async (tx: Tx) => {
    await lockApplication(tx, applicationId);
    const app = await tx.application.findUnique({
      where: { id: applicationId },
      select: { status: true, ...USER_CONTENT_SELECT },
    });
    if (!app) return true;
    if (opts.requireStatus && app.status !== opts.requireStatus) return false;
    if (holdsUserContent({ notes: opts.ignoreNotes ? null : app.notes, coverLetter: app.coverLetter })) return false;
    await tx.application.delete({ where: { id: applicationId } });
    return true;
  };
  if (opts.tx) return run(opts.tx);
  const { prisma } = await import("@/lib/db");
  return prisma.$transaction(run);
}
