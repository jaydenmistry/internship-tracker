"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth-guard";
import { createContact, deleteContact, updateContact } from "@/lib/networking/contacts";
import { civilDate, parseCivilDate, startOfCivilDay } from "@/lib/networking/dates";
import {
  networkingTimeZone,
  saveNetworkingSettings,
  SettingsSavedRecomputeFailedError,
} from "@/lib/networking/followups";
import { deleteMessage, editMessage, logMessage, setManualStatus, setSnooze } from "@/lib/networking/messages";
import { contactInputSchema, messageEditSchema, messageInputSchema } from "@/lib/networking/schema";
import { NetworkingSettingsSchema } from "@/lib/networking/settings";

/**
 * Contact mutations from /network. A Server Action is a public POST endpoint,
 * so every payload is validated with Zod first, and nothing throws across the
 * boundary: the form needs a plain `ok: false` with a message it can show next
 * to the fields the user just typed, not an exception that loses them.
 */

export type NetworkActionResult<T = object> = ({ ok: true } & T) | { ok: false; message: string };

const idSchema = z.string().min(1).max(100);

const updateSchema = z.object({ contactId: idSchema, contact: contactInputSchema });
const deleteSchema = z.object({ contactId: idSchema });
const logSchema = z.object({ contactId: idSchema, message: messageInputSchema });
const editSchema = z.object({ messageId: idSchema, edit: messageEditSchema });
const messageIdSchema = z.object({ messageId: idSchema });
const manualSchema = z.object({ contactId: idSchema, status: z.enum(["CHATTED", "REFERRED"]).nullable() });
const snoozeSchema = z.object({ contactId: idSchema, until: z.string().max(10).nullable() });

function invalid(error: z.ZodError): { ok: false; message: string } {
  const issue = error.issues[0];
  const field = issue?.path.filter((p) => !["contact", "message", "edit"].includes(String(p))).join(".");
  return {
    ok: false,
    message: issue ? `${field || "payload"}: ${issue.message}` : "invalid payload",
  };
}

function failed(verb: string, err: unknown): { ok: false; message: string } {
  return { ok: false, message: `${verb} failed: ${err instanceof Error ? err.message : String(err)}` };
}

export async function createContactAction(payload: unknown): Promise<NetworkActionResult<{ id: string }>> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a 401, not the contact list.
  await requireSession();
  const parsed = contactInputSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    const { id } = await createContact(parsed.data);
    return { ok: true, id };
  } catch (err) {
    return failed("adding the contact", err);
  }
}

export async function updateContactAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = updateSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await updateContact(parsed.data.contactId, parsed.data.contact);
  } catch (err) {
    return failed("saving the contact", err);
  }
  // Re-render the contact page so the saved values (and a newly created
  // company link) come from the server, not the form's copy.
  refresh();
  return { ok: true };
}

export async function deleteContactAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = deleteSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await deleteContact(parsed.data.contactId);
  } catch (err) {
    return failed("deleting the contact", err);
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Messages and follow-up inputs. Each mutation recomputes the contact's
// follow-up state in its own transaction (lib/networking/messages.ts), then
// re-renders the page so the timeline and status come from the server.
// ---------------------------------------------------------------------------

export async function logMessageAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = logSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await logMessage(parsed.data.contactId, parsed.data.message);
  } catch (err) {
    return failed("logging the message", err);
  }
  refresh();
  return { ok: true };
}

export async function editMessageAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = editSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await editMessage(parsed.data.messageId, parsed.data.edit);
  } catch (err) {
    return failed("saving the message", err);
  }
  refresh();
  return { ok: true };
}

export async function deleteMessageAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = messageIdSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await deleteMessage(parsed.data.messageId);
  } catch (err) {
    return failed("deleting the message", err);
  }
  refresh();
  return { ok: true };
}

export async function setManualStatusAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = manualSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await setManualStatus(parsed.data.contactId, parsed.data.status);
  } catch (err) {
    return failed("setting the status", err);
  }
  refresh();
  return { ok: true };
}

export async function snoozeAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = snoozeSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  let until: Date | null = null;
  if (parsed.data.until !== null) {
    const day = parseCivilDate(parsed.data.until);
    if (!day) return { ok: false, message: "until: expected a date like 2026-10-01" };
    const tz = networkingTimeZone();
    until = startOfCivilDay(day, tz);
    const today = startOfCivilDay(civilDate(new Date(), tz), tz);
    if (until.getTime() < today.getTime()) return { ok: false, message: "until: pick today or a later date" };
  }
  try {
    await setSnooze(parsed.data.contactId, until);
  } catch (err) {
    return failed("snoozing", err);
  }
  refresh();
  return { ok: true };
}

export async function saveNetworkingSettingsAction(payload: unknown): Promise<NetworkActionResult> {
  // See createContactAction: guarded independently of proxy.ts.
  await requireSession();
  const parsed = NetworkingSettingsSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);
  try {
    await saveNetworkingSettings(parsed.data);
  } catch (err) {
    if (err instanceof SettingsSavedRecomputeFailedError) {
      refresh();
      return { ok: false, message: err.message };
    }
    return failed("saving the settings", err);
  }
  refresh();
  return { ok: true };
}
