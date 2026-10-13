import { randomUUID } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/db";

/**
 * Saved views for the listings table: a name plus the table's URL query
 * (filters and sort, as `viewToQuery` writes it). Stored as one JSON row in
 * `Setting`, so they follow the user to every device. At most one is the
 * default, which `/` opens when the URL carries no query of its own.
 *
 * The query is stored verbatim and parsed by `viewFromQuery` on the way back
 * in, which validates every field — a stale or hand-edited view degrades to
 * the default filters rather than breaking the table.
 */

export const LISTING_VIEWS_KEY = "listings.views";
export const VIEW_NAME_MAX = 60;
export const VIEW_QUERY_MAX = 2000;
export const MAX_VIEWS = 30;

const SavedViewSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(VIEW_NAME_MAX),
  query: z.string().max(VIEW_QUERY_MAX),
  isDefault: z.boolean(),
});

export type SavedView = z.infer<typeof SavedViewSchema>;

/** Drops any entry that no longer parses instead of losing them all. */
export function parseSavedViews(raw: unknown): SavedView[] {
  if (!Array.isArray(raw)) return [];
  const views: SavedView[] = [];
  let sawDefault = false;
  for (const item of raw) {
    const parsed = SavedViewSchema.safeParse(item);
    if (!parsed.success) continue;
    // Only the first default counts, should the stored list ever hold two.
    const isDefault: boolean = parsed.data.isDefault && !sawDefault;
    sawDefault ||= isDefault;
    views.push({ ...parsed.data, isDefault });
  }
  return views.slice(0, MAX_VIEWS);
}

export async function loadSavedViews(): Promise<SavedView[]> {
  const row = await prisma.setting.findUnique({ where: { key: LISTING_VIEWS_KEY } });
  return parseSavedViews(row?.value);
}

export class ViewLimitError extends Error {
  constructor() {
    super(`You can keep up to ${MAX_VIEWS} saved views. Delete one first.`);
    this.name = "ViewLimitError";
  }
}

/**
 * Read-modify-write of the one Setting row. Serializable, so two tabs saving
 * at once can't both read the same list and silently drop each other's view
 * (Postgres aborts one instead, and the action reports the failure).
 */
async function updateViews(change: (views: SavedView[]) => SavedView[]): Promise<SavedView[]> {
  return prisma.$transaction(
    async (tx) => {
      const row = await tx.setting.findUnique({ where: { key: LISTING_VIEWS_KEY } });
      const next = change(parseSavedViews(row?.value));
      await tx.setting.upsert({
        where: { key: LISTING_VIEWS_KEY },
        create: { key: LISTING_VIEWS_KEY, value: next },
        update: { value: next },
      });
      return next;
    },
    { isolationLevel: "Serializable" },
  );
}

/**
 * Saves a query under a name. A view with the same name (ignoring case) is
 * overwritten in place. Saving with `isDefault` makes it the only default;
 * saving without it keeps whatever default status the view already had —
 * unsetting a default is the star button's job, not a side effect of
 * updating the view's filters.
 */
export function withViewSaved(
  views: readonly SavedView[],
  input: { name: string; query: string; isDefault: boolean },
  newId: () => string,
): SavedView[] {
  const name = input.name.trim();
  const existing = views.find((v) => v.name.toLowerCase() === name.toLowerCase());
  if (!existing && views.length >= MAX_VIEWS) throw new ViewLimitError();
  const id = existing?.id ?? newId();
  const isDefault = input.isDefault || (existing?.isDefault ?? false);
  const saved: SavedView = { id, name, query: input.query, isDefault };
  const others = views.map((v) => (input.isDefault ? { ...v, isDefault: false } : v));
  return existing ? others.map((v) => (v.id === id ? saved : v)) : [...others, saved];
}

export function withViewDeleted(views: readonly SavedView[], id: string): SavedView[] {
  return views.filter((v) => v.id !== id);
}

/** Makes one view the default, or clears the default when `id` is null. */
export function withDefaultView(views: readonly SavedView[], id: string | null): SavedView[] {
  return views.map((v) => ({ ...v, isDefault: v.id === id }));
}

export async function saveView(input: {
  name: string;
  query: string;
  isDefault: boolean;
}): Promise<SavedView[]> {
  return updateViews((views) => withViewSaved(views, input, randomUUID));
}

export async function deleteView(id: string): Promise<SavedView[]> {
  return updateViews((views) => withViewDeleted(views, id));
}

export async function setDefaultView(id: string | null): Promise<SavedView[]> {
  return updateViews((views) => withDefaultView(views, id));
}
