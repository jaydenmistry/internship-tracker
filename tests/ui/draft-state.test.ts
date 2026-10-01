import { describe, expect, it } from "vitest";
import {
  buildMailto,
  draftChannels,
  draftTypeForDue,
  emptyEditor,
  MAILTO_MAX,
  markSentPayload,
  parseDraftParam,
} from "@/app/network/draft-state";

describe("draft-state", () => {
  it("maps what's due to the draft type", () => {
    expect(draftTypeForDue("FOLLOW_UP")).toBe("FOLLOW_UP");
    expect(draftTypeForDue("CHECK_IN")).toBe("FOLLOW_UP");
    expect(draftTypeForDue("THANK_YOU")).toBe("THANK_YOU");
    expect(draftTypeForDue("SEND_OPENER")).toBe("COLD");
    expect(draftTypeForDue(null)).toBe("COLD");
  });

  it("accepts only real draft types from the URL", () => {
    expect(parseDraftParam("REFERRAL_ASK")).toBe("REFERRAL_ASK");
    expect(parseDraftParam("REPLY")).toBeNull();
    expect(parseDraftParam("<script>")).toBeNull();
    expect(parseDraftParam(undefined)).toBeNull();
  });

  it("offers only channels the message rules allow", () => {
    expect(draftChannels("CONNECT_NOTE")).toEqual(["LINKEDIN"]);
    expect(draftChannels("COLD")).toEqual(["EMAIL", "LINKEDIN"]);
  });

  it("builds a mailto with an encoded subject and CRLF body", () => {
    expect(buildMailto("sam@stripe.com", "Hi & bye", "line 1\nline 2")).toBe(
      "mailto:sam@stripe.com?subject=Hi%20%26%20bye&body=line%201%0D%0Aline%202",
    );
  });

  it("refuses an address that could smuggle headers, and a URL too long for Windows clients", () => {
    expect(buildMailto("sam@stripe.com?bcc=x@evil.test", "s", "b")).toBeNull();
    expect(buildMailto("sam@stripe.com&cc=x", "s", "b")).toBeNull();
    expect(buildMailto("sam@stripe.com%0Abcc:x", "s", "b")).toBeNull();
    expect(buildMailto(null, "s", "b")).toBeNull();
    expect(buildMailto("sam@stripe.com", "s", "x".repeat(MAILTO_MAX))).toBeNull();
  });

  it("Mark sent drops a subject off-email and carries the original draft", () => {
    const e = { ...emptyEditor("FOLLOW_UP", "LINKEDIN", "l1"), subject: "Re: hi", body: "edited", draftBody: "draft" };
    expect(markSentPayload(e, new Date("2026-09-25T16:00:00Z"))).toEqual({
      direction: "OUT",
      type: "FOLLOW_UP",
      channel: "LINKEDIN",
      subject: "",
      body: "edited",
      sentAt: "2026-09-25T16:00:00.000Z",
      listingId: "l1",
      draftBody: "draft",
    });
  });
});
