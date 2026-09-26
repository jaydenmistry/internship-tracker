import type {
  ContactStatus,
  OutreachChannel,
  OutreachDirection,
  OutreachType,
} from "@/generated/prisma/enums";
import { businessDaysAfter } from "@/lib/networking/dates";

/**
 * The follow-up engine: a contact's messages and manual inputs in, its derived
 * status and next due date out. Pure and deterministic — no database, no
 * clock (the caller passes `now`). The ONLY writer of Contact.status,
 * nextFollowUpAt and followUpsSent is the code that stores this function's
 * result (lib/networking/followups.ts).
 *
 * The rules, in order of precedence (docs/NETWORKING_PLAN.md, "Follow-up
 * engine"):
 *
 *  - Opener: an outbound COLD or REFERRAL_ASK on EMAIL or LINKEDIN. The latest
 *    one defines the current cadence; followUpsSent counts outbound
 *    FOLLOW_UPs after it.
 *  - Manual status (rule 2): CHATTED/REFERRED set by hand, or CHATTED implied
 *    by a logged MEETING (dated at the meeting; the later of the two wins). It
 *    holds until a NEWER opener supersedes it. Under a manual status the only
 *    reminder is a thank-you for a meeting with no THANK_YOU after it.
 *  - Otherwise the latest of {opener, CONNECT_NOTE, ACCEPTED} decides:
 *      opener       → REPLIED if an inbound REPLY follows; else AWAITING_REPLY
 *                     with a follow-up due, until maxFollowUps is reached;
 *                     then COLD once the last wait has passed as of `now`.
 *      CONNECT_NOTE → REPLIED if they replied, else PENDING_CONNECTION, no date.
 *      ACCEPTED     → REPLIED if they replied, else NOT_CONTACTED with a
 *                     "send opener" due the next business day.
 *  - Nothing of the above: REPLIED if they ever replied, else NOT_CONTACTED.
 *  - Snooze (followUpOverrideAt) replaces the due date — or adds a check-in
 *    when there was none.
 *  - doNotContact clears the due date; the status is still computed.
 */

export interface FollowUpMessage {
  direction: OutreachDirection;
  channel: OutreachChannel;
  type: OutreachType;
  sentAt: Date;
}

export interface FollowUpInputs {
  doNotContact: boolean;
  manualStatus: ContactStatus | null;
  manualStatusAt: Date | null;
  followUpOverrideAt: Date | null;
}

export interface Cadence {
  firstFollowUpBusinessDays: number;
  secondFollowUpBusinessDays: number;
  maxFollowUps: number;
}

/** What is due — drives the Due list's labels and, later, the draft type. */
export type DueKind = "FOLLOW_UP" | "THANK_YOU" | "SEND_OPENER" | "CHECK_IN";

export interface FollowUpState {
  status: ContactStatus;
  nextFollowUpAt: Date | null;
  followUpsSent: number;
  /** Null exactly when nextFollowUpAt is null. */
  dueKind: DueKind | null;
}

/** Statuses a person can set by hand. Anything else in manualStatus is ignored. */
export const MANUAL_STATUSES = ["CHATTED", "REFERRED"] as const satisfies readonly ContactStatus[];

const isOpener = (m: FollowUpMessage) =>
  m.direction === "OUT" &&
  (m.type === "COLD" || m.type === "REFERRAL_ASK") &&
  (m.channel === "EMAIL" || m.channel === "LINKEDIN");

function lastIndex<T>(xs: readonly T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i -= 1) if (pred(xs[i])) return i;
  return -1;
}

export function computeFollowUpState(
  messages: readonly FollowUpMessage[],
  contact: FollowUpInputs,
  cadence: Cadence,
  timeZone: string | undefined,
  now: Date,
): FollowUpState {
  // Stable sort: messages logged with the same timestamp keep their order.
  const msgs = [...messages].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime());
  // A reply stamped at the SAME time as the event counts as after it: you
  // can't reply to something before it's sent, and log times have minute
  // precision. This makes ties independent of insertion order.
  const repliedAfter = (i: number) =>
    msgs.some(
      (m, j) =>
        j !== i &&
        m.direction === "IN" &&
        m.type === "REPLY" &&
        (j > i || m.sentAt.getTime() === msgs[i].sentAt.getTime()),
    );

  const openerIdx = lastIndex(msgs, isOpener);
  const followUps =
    openerIdx < 0 ? [] : msgs.slice(openerIdx + 1).filter((m) => m.direction === "OUT" && m.type === "FOLLOW_UP");
  const followUpsSent = followUps.length;

  let status: ContactStatus;
  let due: { at: Date; kind: DueKind } | null = null;

  // --- Rule 2: manual status (explicit, or implied by a meeting) -----------
  const meetingIdx = lastIndex(msgs, (m) => m.direction === "OUT" && m.type === "MEETING");
  const meeting = meetingIdx >= 0 ? msgs[meetingIdx] : null;
  const explicit =
    contact.manualStatus !== null &&
    (MANUAL_STATUSES as readonly ContactStatus[]).includes(contact.manualStatus) &&
    contact.manualStatusAt !== null
      ? { status: contact.manualStatus, at: contact.manualStatusAt }
      : null;
  const implied = meeting ? { status: "CHATTED" as const, at: meeting.sentAt } : null;
  // The later wins; on a tie the explicit choice does.
  const manual =
    explicit && implied ? (implied.at.getTime() > explicit.at.getTime() ? implied : explicit) : (explicit ?? implied);
  const opener = openerIdx >= 0 ? msgs[openerIdx] : null;

  if (manual && !(opener && opener.sentAt.getTime() > manual.at.getTime())) {
    status = manual.status;
    const openerAfterMeeting = opener && meeting && openerIdx > meetingIdx;
    const thanked = meetingIdx >= 0 && msgs.some((m, j) => j > meetingIdx && m.direction === "OUT" && m.type === "THANK_YOU");
    if (meeting && !openerAfterMeeting && !thanked) {
      due = { at: businessDaysAfter(meeting.sentAt, 1, timeZone), kind: "THANK_YOU" };
    }
  } else {
    // --- Rules 3–6: the latest opener / connection event decides ----------
    const eventIdx = lastIndex(
      msgs,
      (m) =>
        isOpener(m) ||
        (m.direction === "OUT" && m.type === "CONNECT_NOTE") ||
        (m.direction === "IN" && m.type === "ACCEPTED"),
    );

    if (eventIdx < 0) {
      status = msgs.some((m) => m.direction === "IN" && m.type === "REPLY") ? "REPLIED" : "NOT_CONTACTED";
    } else if (repliedAfter(eventIdx)) {
      status = "REPLIED";
    } else {
      const event = msgs[eventIdx];
      if (isOpener(event)) {
        const anchor = followUps.length > 0 ? followUps[followUps.length - 1].sentAt : event.sentAt;
        const wait = followUpsSent === 0 ? cadence.firstFollowUpBusinessDays : cadence.secondFollowUpBusinessDays;
        const dueAt = businessDaysAfter(anchor, wait, timeZone);
        if (followUpsSent < cadence.maxFollowUps) {
          status = "AWAITING_REPLY";
          due = { at: dueAt, kind: "FOLLOW_UP" };
        } else {
          status = now.getTime() >= dueAt.getTime() ? "COLD" : "AWAITING_REPLY";
        }
      } else if (event.type === "CONNECT_NOTE") {
        // Nothing to follow up on until they accept; the table shows the age.
        status = "PENDING_CONNECTION";
      } else {
        status = "NOT_CONTACTED";
        due = { at: businessDaysAfter(event.sentAt, 1, timeZone), kind: "SEND_OPENER" };
      }
    }
  }

  // --- Rule 8: snooze, then rule 1: do-not-contact -------------------------
  if (contact.followUpOverrideAt) {
    due = { at: contact.followUpOverrideAt, kind: due?.kind ?? "CHECK_IN" };
  }
  if (contact.doNotContact) due = null;

  return { status, nextFollowUpAt: due?.at ?? null, followUpsSent, dueKind: due?.kind ?? null };
}
