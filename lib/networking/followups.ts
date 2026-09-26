import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { civilDate, endOfDay, startOfCivilDay } from "@/lib/networking/dates";
import { computeFollowUpState, type DueKind, type FollowUpState } from "@/lib/networking/followup";
import {
  DEFAULT_NETWORKING_SETTINGS,
  NETWORKING_SETTINGS_KEY,
  NetworkingSettingsSchema,
  parseNetworkingSettings,
  type NetworkingSettings,
} from "@/lib/networking/settings";

/**
 * Persistence for the follow-up engine. `storeFollowUpState` is the ONE place
 * Contact.status / nextFollowUpAt / followUpsSent are written; every mutation
 * that changes a contact's messages or manual inputs calls it in the same
 * transaction, and the time-based recompute calls it for the contacts whose
 * state can change with the clock alone.
 */

type Db = typeof prisma | Prisma.TransactionClient;

export interface FollowUpContext {
  settings: NetworkingSettings;
  timeZone: string | undefined;
  now: Date;
}

/** The zone due dates are computed in — the same one alerts use. */
export function networkingTimeZone(): string | undefined {
  return process.env.ALERT_TIMEZONE?.trim() || undefined;
}

export async function loadNetworkingSettings(db: Db = prisma): Promise<NetworkingSettings> {
  let row: { value: unknown } | null = null;
  try {
    row = await db.setting.findUnique({ where: { key: NETWORKING_SETTINGS_KEY } });
  } catch (err) {
    // Inside an interactive transaction a failed statement aborts it; falling
    // back to defaults would only make the NEXT statement fail, confusingly.
    if (db !== prisma) throw err;
    console.warn(`[networking] could not read ${NETWORKING_SETTINGS_KEY}, using defaults:`, err);
    return DEFAULT_NETWORKING_SETTINGS;
  }
  const { settings, issues } = parseNetworkingSettings(row?.value ?? undefined);
  if (issues.length > 0) {
    console.warn(`[networking] ignoring invalid ${NETWORKING_SETTINGS_KEY} fields: ${issues.join("; ")}`);
  }
  return settings;
}

export async function followUpContext(db: Db = prisma, now = new Date()): Promise<FollowUpContext> {
  return { settings: await loadNetworkingSettings(db), timeZone: networkingTimeZone(), now };
}

const MESSAGE_ORDER: Prisma.OutreachMessageOrderByWithRelationInput[] = [
  { sentAt: "asc" },
  { createdAt: "asc" },
  { id: "asc" },
];

const INPUT_SELECT = {
  id: true,
  doNotContact: true,
  manualStatus: true,
  manualStatusAt: true,
  followUpOverrideAt: true,
  // Ordered: the engine breaks sentAt ties by input order, and Postgres gives
  // no order without ORDER BY (an UPDATE moves the row). Same tiebreak as the
  // timeline, so what you see is what the engine reasons about.
  messages: {
    select: { direction: true, channel: true, type: true, sentAt: true },
    orderBy: MESSAGE_ORDER,
  },
} as const;

type InputRecord = Prisma.ContactGetPayload<{ select: typeof INPUT_SELECT }>;

function compute(c: InputRecord, ctx: FollowUpContext): FollowUpState {
  return computeFollowUpState(c.messages, c, ctx.settings, ctx.timeZone, ctx.now);
}

async function store(db: Db, id: string, s: FollowUpState): Promise<void> {
  await db.contact.update({
    where: { id },
    data: { status: s.status, nextFollowUpAt: s.nextFollowUpAt, followUpsSent: s.followUpsSent },
  });
}

/** One contact's state as of `ctx.now`, read-only — for rendering its page. */
export async function peekFollowUpState(contactId: string, ctx: FollowUpContext): Promise<FollowUpState | null> {
  const c = await prisma.contact.findUnique({ where: { id: contactId }, select: INPUT_SELECT });
  return c ? compute(c, ctx) : null;
}

/** The zone name to render due days in, resolved on the server. */
export function displayTimeZone(): string {
  return networkingTimeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Recompute and store one contact. Call inside the mutation's transaction. */
export async function storeFollowUpState(db: Db, contactId: string, ctx: FollowUpContext): Promise<FollowUpState> {
  const c = await db.contact.findUniqueOrThrow({ where: { id: contactId }, select: INPUT_SELECT });
  const state = compute(c, ctx);
  await store(db, contactId, state);
  return state;
}

/**
 * Recompute every contact matching `where`, writing only the rows whose state
 * actually changed. Returns each contact's fresh state (with its due kind,
 * which is not stored) so a caller can use it without a second query.
 */
async function recomputeWhere(
  where: Prisma.ContactWhereInput,
  ctx: FollowUpContext,
): Promise<Map<string, FollowUpState>> {
  const rows = await prisma.contact.findMany({
    where,
    select: { ...INPUT_SELECT, status: true, nextFollowUpAt: true, followUpsSent: true, updatedAt: true },
  });
  const out = new Map<string, FollowUpState>();
  for (const c of rows) {
    const s = compute(c, ctx);
    const changed =
      s.status !== c.status ||
      s.followUpsSent !== c.followUpsSent ||
      (s.nextFollowUpAt?.getTime() ?? null) !== (c.nextFollowUpAt?.getTime() ?? null);
    if (!changed) {
      out.set(c.id, s);
      continue;
    }
    // Optimistic: write only if the row still holds what we read, AND no
    // message or input changed since (updatedAt — every mutation bumps it,
    // and a message write always stores the contact in its transaction). A
    // concurrent logMessage that committed in between wins; its own
    // transaction already stored the right state. We then re-read that row
    // rather than report our stale answer.
    const { count } = await prisma.contact.updateMany({
      where: {
        id: c.id,
        updatedAt: c.updatedAt,
        status: c.status,
        followUpsSent: c.followUpsSent,
        nextFollowUpAt: c.nextFollowUpAt,
      },
      // Keep updatedAt: a change caused by the clock alone (a COLD flip)
      // shouldn't float the contact to the top of "recently updated".
      data: { status: s.status, nextFollowUpAt: s.nextFollowUpAt, followUpsSent: s.followUpsSent, updatedAt: c.updatedAt },
    });
    if (count === 1) {
      out.set(c.id, s);
    } else {
      const fresh = await prisma.contact.findUnique({ where: { id: c.id }, select: INPUT_SELECT });
      if (fresh) out.set(c.id, compute(fresh, ctx));
    }
  }
  return out;
}

/**
 * The contacts whose state can change with time alone: AWAITING_REPLY (it
 * goes COLD once the last wait passes) and anything with a due date. Tens of
 * rows at most. Run by the digest (lib/alerts/send.ts) and on /network load.
 */
export function recomputeTimeSensitive(ctx: FollowUpContext): Promise<Map<string, FollowUpState>> {
  return recomputeWhere({ OR: [{ status: "AWAITING_REPLY" }, { nextFollowUpAt: { not: null } }] }, ctx);
}

/** Every contact — after the cadence settings change. */
export function recomputeAll(ctx: FollowUpContext): Promise<Map<string, FollowUpState>> {
  return recomputeWhere({}, ctx);
}

/** The settings row was written; only the follow-on recompute failed. */
export class SettingsSavedRecomputeFailedError extends Error {
  constructor(cause: unknown) {
    super(
      `settings saved, but recomputing due dates failed (they catch up on the next /network load or digest): ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SettingsSavedRecomputeFailedError";
  }
}

export async function saveNetworkingSettings(input: unknown, now = new Date()): Promise<NetworkingSettings> {
  const settings = NetworkingSettingsSchema.parse(input);
  await prisma.setting.upsert({
    where: { key: NETWORKING_SETTINGS_KEY },
    create: { key: NETWORKING_SETTINGS_KEY, value: settings },
    update: { value: settings },
  });
  // The cadence feeds every stored due date; recompute them all. Not in the
  // same transaction on purpose: it touches every contact, and a failure
  // here must not undo a save the user made.
  try {
    await recomputeAll({ settings, timeZone: networkingTimeZone(), now });
  } catch (err) {
    throw new SettingsSavedRecomputeFailedError(err);
  }
  return settings;
}

// ---------------------------------------------------------------------------
// The Due list
// ---------------------------------------------------------------------------

export interface DueFollowUp {
  contactId: string;
  name: string;
  company: string | null;
  kind: DueKind;
  dueAt: Date;
  overdue: boolean;
}

/**
 * Everyone due today or earlier, oldest first. Recomputes the time-sensitive
 * set first, so a contact that went COLD overnight is not listed as due and
 * the page is right even when the digest cron isn't configured.
 */
export async function loadDueFollowUps(ctx: FollowUpContext): Promise<DueFollowUp[]> {
  const states = await recomputeTimeSensitive(ctx);
  const cutoff = endOfDay(ctx.now, ctx.timeZone);
  const startOfToday = startOfCivilDay(civilDate(ctx.now, ctx.timeZone), ctx.timeZone);
  const dueIds = [...states.entries()]
    .filter(([, s]) => s.nextFollowUpAt !== null && s.nextFollowUpAt.getTime() <= cutoff.getTime())
    .map(([id]) => id);
  if (dueIds.length === 0) return [];

  const rows = await prisma.contact.findMany({
    where: { id: { in: dueIds } },
    select: { id: true, name: true, company: { select: { name: true } } },
  });
  return rows
    .map((r) => {
      const s = states.get(r.id)!;
      return {
        contactId: r.id,
        name: r.name,
        company: r.company?.name ?? null,
        kind: s.dueKind!,
        dueAt: s.nextFollowUpAt!,
        overdue: s.nextFollowUpAt!.getTime() < startOfToday.getTime(),
      };
    })
    .sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.name.localeCompare(b.name));
}
