"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { requireSession } from "@/lib/auth-guard";
import { createContact, deleteContact, updateContact } from "@/lib/networking/contacts";
import { contactInputSchema } from "@/lib/networking/schema";

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

function invalid(error: z.ZodError): { ok: false; message: string } {
  const issue = error.issues[0];
  const field = issue?.path.filter((p) => p !== "contact").join(".");
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
