"use server";

import { z } from "zod";
import { refresh } from "next/cache";
import { AlertKind } from "@/generated/prisma/enums";
import { AlertSettingsSchema, saveAlertSettings } from "@/lib/alerts/config";
import { sendAlerts, type SendAlertsResult } from "@/lib/alerts/send";
import { requireSession } from "@/lib/auth-guard";

/**
 * Server boundary for /alerts. A Server Action is a public POST endpoint, so
 * both payloads are untrusted and validated with Zod before anything is written
 * or sent. Nothing throws across the boundary — the client renders the message.
 *
 * Manual sends call `sendAlerts` directly, the same code path the worker's cron
 * uses. Routing them through the worker's internal HTTP endpoint would add a
 * hop that can fail on its own and would test something other than the thing
 * cron actually runs.
 */

export type AlertsActionResult = { ok: true; message: string } | { ok: false; message: string };

function invalid(error: z.ZodError): { ok: false; message: string } {
  const issue = error.issues[0];
  return {
    ok: false,
    message: issue ? `${issue.path.join(".") || "payload"}: ${issue.message}` : "invalid payload",
  };
}

export async function saveAlertSettingsAction(payload: unknown): Promise<AlertsActionResult> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = AlertSettingsSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  try {
    await saveAlertSettings(parsed.data);
  } catch (err) {
    return { ok: false, message: `Could not save: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Re-render the page so the saved values, and the channel readiness derived
  // from the toggles, replace the local form state together.
  refresh();
  return { ok: true, message: "Thresholds saved." };
}

const sendSchema = z.object({ kind: z.enum(AlertKind) });

/**
 * Honest about dedupe: an alert AlertLog already covers is reported as such
 * rather than silently doing nothing, because "Send now" producing no message
 * and no explanation is indistinguishable from a broken channel.
 */
function describe(result: SendAlertsResult): string {
  const parts: string[] = [];

  if (result.sent > 0) {
    parts.push(`Sent ${result.sent} ${result.sent === 1 ? "message" : "messages"}.`);
  } else if (result.built === 0) {
    parts.push("Nothing matched the current thresholds, so there was nothing to send.");
  } else if (result.alreadySent > 0) {
    parts.push("Nothing new to send.");
  } else if (result.unavailable.length > 0 && result.failures.length === 0) {
    parts.push("No channel was available to send on.");
  }

  if (result.alreadySent > 0) {
    parts.push(
      `${result.alreadySent} ${
        result.alreadySent === 1 ? "delivery was" : "deliveries were"
      } skipped — already in the alert log.`,
    );
  }
  if (result.capped > 0) parts.push(`${result.capped} held back by the per-run cap; run again for more.`);
  for (const u of result.unavailable) parts.push(`${u.channel}: ${u.reason}.`);
  for (const f of result.failures) parts.push(`${f.channel} failed: ${f.error}`);

  return parts.join(" ");
}

export async function sendAlertNowAction(payload: unknown): Promise<AlertsActionResult> {
  // Every Server Action is a public POST endpoint. proxy.ts already blocks
  // unauthenticated callers, but this does not rely on that: a matcher mistake
  // must cost a redirect, not the catalog.
  await requireSession();
  const parsed = sendSchema.safeParse(payload);
  if (!parsed.success) return invalid(parsed.error);

  let result: SendAlertsResult;
  try {
    result = await sendAlerts(parsed.data.kind, {
      timeZone: process.env.ALERT_TIMEZONE?.trim() || undefined,
    });
  } catch (err) {
    return { ok: false, message: `Send failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  // Refresh so the recent-alerts list below the buttons shows what just went
  // out — that list is the evidence the button actually did something.
  refresh();
  const message = describe(result);
  return result.failures.length > 0
    ? { ok: false, message }
    : { ok: true, message: message || "Nothing to send." };
}
