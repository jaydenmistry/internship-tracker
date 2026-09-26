import { describe, expect, it } from "vitest";
import {
  computeFollowUpState,
  type Cadence,
  type FollowUpInputs,
  type FollowUpMessage,
} from "@/lib/networking/followup";

const TZ = "America/New_York";
const CADENCE: Cadence = { firstFollowUpBusinessDays: 5, secondFollowUpBusinessDays: 7, maxFollowUps: 2 };
const NONE: FollowUpInputs = { doNotContact: false, manualStatus: null, manualStatusAt: null, followUpOverrideAt: null };

/** Noon New York time on a September/October 2026 day — safely mid-day. */
const at = (day: string) => new Date(`2026-${day}T16:00:00Z`);
/** Local midnight New York (EDT) on that day. */
const midnight = (day: string) => new Date(`2026-${day}T04:00:00Z`);

const msg = (
  type: FollowUpMessage["type"],
  day: string,
  over: Partial<FollowUpMessage> = {},
): FollowUpMessage => ({
  direction: type === "ACCEPTED" ? "IN" : "OUT",
  channel: type === "CONNECT_NOTE" || type === "ACCEPTED" ? "LINKEDIN" : type === "MEETING" ? "IN_PERSON" : "EMAIL",
  type,
  sentAt: at(day),
  ...over,
});
const reply = (day: string) => msg("REPLY", day, { direction: "IN" });

function run(messages: FollowUpMessage[], opts: { now?: string; contact?: Partial<FollowUpInputs>; cadence?: Partial<Cadence> } = {}) {
  return computeFollowUpState(
    messages,
    { ...NONE, ...opts.contact },
    { ...CADENCE, ...opts.cadence },
    TZ,
    at(opts.now ?? "09-25"),
  );
}

describe("nothing sent", () => {
  it("is NOT_CONTACTED with no date", () => {
    expect(run([])).toEqual({ status: "NOT_CONTACTED", nextFollowUpAt: null, followUpsSent: 0, dueKind: null });
  });

  it("an inbound reply out of nowhere is REPLIED, still no date", () => {
    expect(run([reply("09-20")])).toMatchObject({ status: "REPLIED", nextFollowUpAt: null });
  });
});

describe("opener cadence", () => {
  it("first follow-up is due 5 business days after the opener (Fri → next Fri)", () => {
    // 2026-09-25 is a Friday.
    expect(run([msg("COLD", "09-25")])).toEqual({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-02"),
      followUpsSent: 0,
      dueKind: "FOLLOW_UP",
    });
  });

  it("a REFERRAL_ASK on LinkedIn is an opener too", () => {
    expect(run([msg("REFERRAL_ASK", "09-25", { channel: "LINKEDIN" })])).toMatchObject({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-02"),
    });
  });

  it("an opener on another channel starts no cadence", () => {
    expect(run([msg("COLD", "09-25", { channel: "OTHER" })])).toMatchObject({
      status: "NOT_CONTACTED",
      nextFollowUpAt: null,
    });
  });

  it("the second follow-up is due 7 business days after the first", () => {
    // 10-02 (Fri) + 7 business days = 10-13 (Tue).
    expect(run([msg("COLD", "09-25"), msg("FOLLOW_UP", "10-02")], { now: "10-02" })).toEqual({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-13"),
      followUpsSent: 1,
      dueKind: "FOLLOW_UP",
    });
  });

  it("stays AWAITING_REPLY with no date after the last follow-up, then goes COLD once the wait passes", () => {
    const thread = [msg("COLD", "09-25"), msg("FOLLOW_UP", "10-02"), msg("FOLLOW_UP", "10-13")];
    // 10-13 + 7 business days = 10-22.
    expect(run(thread, { now: "10-21" })).toEqual({
      status: "AWAITING_REPLY",
      nextFollowUpAt: null,
      followUpsSent: 2,
      dueKind: null,
    });
    expect(run(thread, { now: "10-22" })).toMatchObject({ status: "COLD", nextFollowUpAt: null });
  });

  it("maxFollowUps = 0 goes COLD after the first wait with no reminder", () => {
    expect(run([msg("COLD", "09-25")], { cadence: { maxFollowUps: 0 }, now: "10-01" })).toMatchObject({
      status: "AWAITING_REPLY",
      nextFollowUpAt: null,
    });
    expect(run([msg("COLD", "09-25")], { cadence: { maxFollowUps: 0 }, now: "10-02" })).toMatchObject({
      status: "COLD",
    });
  });

  it("a reply stops the cadence for good", () => {
    expect(run([msg("COLD", "09-25"), msg("FOLLOW_UP", "10-02"), reply("10-05")], { now: "12-01" })).toEqual({
      status: "REPLIED",
      nextFollowUpAt: null,
      followUpsSent: 1,
      dueKind: null,
    });
  });

  it("a reply to an EARLIER opener doesn't count against a newer one", () => {
    expect(run([msg("COLD", "09-01"), reply("09-02"), msg("COLD", "09-25")])).toMatchObject({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-02"),
    });
  });

  it("counts only follow-ups after the LATEST opener, and a new opener resets the count", () => {
    const thread = [msg("COLD", "09-01"), msg("FOLLOW_UP", "09-08"), msg("FOLLOW_UP", "09-17"), msg("COLD", "09-25")];
    expect(run(thread)).toMatchObject({ followUpsSent: 0, nextFollowUpAt: midnight("10-02") });
  });

  it("sorts messages itself — input order doesn't matter", () => {
    const thread = [msg("FOLLOW_UP", "10-02"), msg("COLD", "09-25")];
    expect(run(thread, { now: "10-02" })).toMatchObject({ followUpsSent: 1, nextFollowUpAt: midnight("10-13") });
  });
});

describe("LinkedIn connection", () => {
  it("a sent connection note is PENDING_CONNECTION with no date, however old", () => {
    expect(run([msg("CONNECT_NOTE", "08-01")], { now: "10-30" })).toEqual({
      status: "PENDING_CONNECTION",
      nextFollowUpAt: null,
      followUpsSent: 0,
      dueKind: null,
    });
  });

  it("a reply to the note is REPLIED", () => {
    expect(run([msg("CONNECT_NOTE", "09-20"), reply("09-21")])).toMatchObject({ status: "REPLIED" });
  });

  it("acceptance returns to NOT_CONTACTED with a 'send opener' due the next business day", () => {
    expect(run([msg("CONNECT_NOTE", "09-20"), msg("ACCEPTED", "09-25")])).toEqual({
      status: "NOT_CONTACTED",
      nextFollowUpAt: midnight("09-28"),
      followUpsSent: 0,
      dueKind: "SEND_OPENER",
    });
  });

  it("an opener after acceptance clears that date and starts the normal cadence", () => {
    expect(run([msg("CONNECT_NOTE", "09-20"), msg("ACCEPTED", "09-24"), msg("COLD", "09-25", { channel: "LINKEDIN" })])).toEqual({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-02"),
      followUpsSent: 0,
      dueKind: "FOLLOW_UP",
    });
  });
});

describe("meetings and manual status", () => {
  it("a meeting implies CHATTED and prompts a thank-you the next business day", () => {
    expect(run([msg("MEETING", "09-25")])).toEqual({
      status: "CHATTED",
      nextFollowUpAt: midnight("09-28"),
      followUpsSent: 0,
      dueKind: "THANK_YOU",
    });
  });

  it("a thank-you clears the prompt; CHATTED stays", () => {
    expect(run([msg("MEETING", "09-25"), msg("THANK_YOU", "09-26")])).toMatchObject({
      status: "CHATTED",
      nextFollowUpAt: null,
    });
  });

  it("a later opener supersedes CHATTED and starts the cadence", () => {
    const thread = [msg("MEETING", "09-01"), msg("THANK_YOU", "09-02"), msg("REFERRAL_ASK", "09-25")];
    expect(run(thread)).toMatchObject({ status: "AWAITING_REPLY", nextFollowUpAt: midnight("10-02") });
  });

  it("a manual status holds until a newer opener, with no reminder", () => {
    const contact = { manualStatus: "REFERRED" as const, manualStatusAt: at("09-26") };
    expect(run([msg("COLD", "09-25")], { contact, now: "12-01" })).toEqual({
      status: "REFERRED",
      nextFollowUpAt: null,
      followUpsSent: 0,
      dueKind: null,
    });
    expect(run([msg("COLD", "09-25"), msg("COLD", "09-28")], { contact, now: "09-28" })).toMatchObject({
      status: "AWAITING_REPLY",
      nextFollowUpAt: midnight("10-05"),
    });
  });

  it("a manual status set after an unthanked meeting still reminds you to say thanks", () => {
    const contact = { manualStatus: "REFERRED" as const, manualStatusAt: at("09-26") };
    expect(run([msg("MEETING", "09-25")], { contact })).toMatchObject({
      status: "REFERRED",
      dueKind: "THANK_YOU",
      nextFollowUpAt: midnight("09-28"),
    });
  });

  it("a meeting after a manual status wins (the later of the two)", () => {
    const contact = { manualStatus: "REFERRED" as const, manualStatusAt: at("09-01") };
    expect(run([msg("MEETING", "09-25")], { contact })).toMatchObject({ status: "CHATTED" });
  });

  it("ignores a manual status outside CHATTED/REFERRED, and one with no timestamp", () => {
    expect(run([], { contact: { manualStatus: "COLD", manualStatusAt: at("09-01") } }).status).toBe("NOT_CONTACTED");
    expect(run([], { contact: { manualStatus: "REFERRED", manualStatusAt: null } }).status).toBe("NOT_CONTACTED");
  });
});

describe("snooze and do-not-contact", () => {
  it("snooze replaces the due date and keeps its kind", () => {
    expect(run([msg("COLD", "09-25")], { contact: { followUpOverrideAt: midnight("10-20") } })).toMatchObject({
      nextFollowUpAt: midnight("10-20"),
      dueKind: "FOLLOW_UP",
    });
  });

  it("snooze on a contact with nothing due adds a check-in", () => {
    expect(run([msg("COLD", "09-01"), reply("09-02")], { contact: { followUpOverrideAt: midnight("10-20") } })).toMatchObject({
      status: "REPLIED",
      nextFollowUpAt: midnight("10-20"),
      dueKind: "CHECK_IN",
    });
  });

  it("doNotContact computes the status but never a date, snoozed or not", () => {
    const contact = { doNotContact: true, followUpOverrideAt: midnight("10-20") };
    expect(run([msg("COLD", "09-25")], { contact })).toEqual({
      status: "AWAITING_REPLY",
      nextFollowUpAt: null,
      followUpsSent: 0,
      dueKind: null,
    });
  });
});

describe("ties", () => {
  it("a reply stamped the same minute as the opener counts, in either input order", () => {
    const t = "09-25";
    expect(run([msg("COLD", t), reply(t)]).status).toBe("REPLIED");
    expect(run([reply(t), msg("COLD", t)]).status).toBe("REPLIED");
    expect(run([reply(t), msg("CONNECT_NOTE", t)]).status).toBe("REPLIED");
  });
});
