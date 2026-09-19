"use server";

import { z } from "zod";
import { AppStatus } from "@/generated/prisma/enums";
import { prisma } from "@/lib/db";
import { matchRows, parseImportText, type ImportRow } from "@/lib/applications/import";
import { commitImport, loadMatchableListings } from "@/lib/applications/commit";
import { toReviewRows } from "./state";
import type { AnalyzeResult, CommitResult, SearchResult } from "./types";

/**
 * Server boundary for the import flow.
 *
 * A Server Action is a public POST endpoint, so every payload here is untrusted
 * and validated with Zod before it reaches the database. The listing catalog
 * (~2,860 rows) is loaded and matched here so it never ships to the browser.
 */

const MAX_TEXT = 200_000; // ~2k pasted lines; well under the 1MB action body cap.

const textSchema = z
  .string()
  .max(MAX_TEXT, `paste is too large (max ${MAX_TEXT} characters)`);

export async function analyzeImport(rawText: unknown): Promise<AnalyzeResult> {
  const parsedInput = textSchema.safeParse(rawText);
  if (!parsedInput.success) {
    return { ok: false, message: parsedInput.error.issues[0]?.message ?? "invalid input" };
  }

  const { rows, errors } = parseImportText(parsedInput.data);
  if (rows.length === 0 && errors.length === 0) {
    return { ok: false, message: "Nothing to import — no rows found in that text." };
  }

  try {
    const listings = await loadMatchableListings();
    return { ok: true, rows: toReviewRows(matchRows(rows, listings)), issues: errors };
  } catch (err) {
    return {
      ok: false,
      message: `Could not load the listing catalog: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}

const commitRowSchema = z.object({
  lineNumber: z.number().int().min(1).max(1_000_000),
  company: z.string().min(1).max(300),
  role: z.string().min(1).max(500),
  location: z.string().max(300).optional(),
  requisitionId: z.string().max(200).optional(),
  // Rejecting anything but http(s) here keeps `javascript:` out of the database
  // and out of the hrefs the application views will later render.
  url: z.string().max(2000).regex(/^https?:\/\//i, "url must be http(s)").optional(),
  raw: z.string().max(4000),
  listingId: z.string().min(1).max(100).nullable(),
});

const commitSchema = z.object({
  rows: z.array(commitRowSchema).min(1, "nothing selected").max(2000),
  status: z.enum(AppStatus).default(AppStatus.APPLIED),
});

export async function commitImportRows(payload: unknown): Promise<CommitResult> {
  const parsed = commitSchema.safeParse(payload);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload",
    };
  }

  const decisions = parsed.data.rows.map((r) => {
    const row: ImportRow = {
      company: r.company,
      role: r.role,
      location: r.location,
      requisitionId: r.requisitionId,
      url: r.url,
      lineNumber: r.lineNumber,
      raw: r.raw,
    };
    return { row, listingId: r.listingId, status: parsed.data.status };
  });

  try {
    return { ok: true, summary: await commitImport(decisions) };
  } catch (err) {
    return {
      ok: false,
      message: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const searchSchema = z.string().min(2).max(120);

/**
 * Catalog search for correcting a bad match by hand. Filtered in Postgres and
 * capped at 12 hits — the full catalog must never reach the client.
 */
export async function searchCatalog(rawQuery: unknown): Promise<SearchResult> {
  const parsed = searchSchema.safeParse(rawQuery);
  if (!parsed.success) return { ok: true, hits: [] };
  const q = parsed.data.trim();

  try {
    const hits = await prisma.listing.findMany({
      where: {
        OR: [
          { title: { contains: q, mode: "insensitive" } },
          { company: { name: { contains: q, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        title: true,
        locations: true,
        finalScore: true,
        company: { select: { name: true } },
        application: { select: { id: true } },
      },
      orderBy: { finalScore: { sort: "desc", nulls: "last" } },
      take: 12,
    });

    return {
      ok: true,
      hits: hits.map((l) => ({
        listingId: l.id,
        company: l.company.name,
        title: l.title,
        location: l.locations.join(", "),
        score: l.finalScore,
        alreadyApplied: l.application !== null,
      })),
    };
  } catch (err) {
    return {
      ok: false,
      message: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
