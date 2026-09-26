import { describe, expect, it } from "vitest";
import { contactInputSchema, parseLinkedinUrl } from "@/lib/networking/schema";

const base = { name: "Sam Lee", kind: "ENGINEER", doNotContact: false } as const;

describe("contactInputSchema", () => {
  it("trims text and turns blank optional fields into null", () => {
    const out = contactInputSchema.parse({
      ...base,
      name: "  Sam Lee  ",
      company: "  Stripe ",
      title: "   ",
      email: "",
      linkedinUrl: "",
      howMet: " career fair ",
      notes: "   ",
    });
    expect(out).toMatchObject({
      name: "Sam Lee",
      company: "Stripe",
      title: null,
      email: null,
      linkedinUrl: null,
      howMet: "career fair",
      notes: null,
    });
  });

  it("treats omitted optional fields as null", () => {
    const out = contactInputSchema.parse(base);
    expect(out.company).toBeNull();
    expect(out.email).toBeNull();
    expect(out.notes).toBeNull();
  });

  it("keeps the line breaks in notes", () => {
    expect(contactInputSchema.parse({ ...base, notes: "line one\n\nline two\n" }).notes).toBe(
      "line one\n\nline two\n",
    );
  });

  it("requires a name that isn't just whitespace", () => {
    expect(contactInputSchema.safeParse({ ...base, name: "   " }).success).toBe(false);
  });

  it("rejects a malformed email", () => {
    expect(contactInputSchema.safeParse({ ...base, email: "not an email" }).success).toBe(false);
    expect(contactInputSchema.parse({ ...base, email: " sam@stripe.com " }).email).toBe("sam@stripe.com");
  });

  it("drops derived follow-up fields a crafted payload tries to set", () => {
    const out = contactInputSchema.parse({
      ...base,
      status: "REFERRED",
      nextFollowUpAt: "2026-10-01T00:00:00Z",
      followUpsSent: 9,
      manualStatus: "REFERRED",
      followUpOverrideAt: "2026-10-01T00:00:00Z",
    });
    for (const key of ["status", "nextFollowUpAt", "followUpsSent", "manualStatus", "followUpOverrideAt"]) {
      expect(out).not.toHaveProperty(key);
    }
  });

  it("rejects an unknown kind", () => {
    expect(contactInputSchema.safeParse({ ...base, kind: "CEO" }).success).toBe(false);
  });

  it("caps field lengths", () => {
    expect(contactInputSchema.safeParse({ ...base, name: "x".repeat(201) }).success).toBe(false);
    expect(contactInputSchema.safeParse({ ...base, notes: "x".repeat(20_001) }).success).toBe(false);
  });

  it("normalizes a LinkedIn URL and rejects anything else", () => {
    expect(
      contactInputSchema.parse({ ...base, linkedinUrl: "https://www.linkedin.com/in/sam-lee" }).linkedinUrl,
    ).toBe("https://www.linkedin.com/in/sam-lee");
    const bad = contactInputSchema.safeParse({ ...base, linkedinUrl: "javascript:alert(1)" });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues[0].message).toMatch(/linkedin\.com/);
  });
});

describe("parseLinkedinUrl", () => {
  it.each([
    ["https://linkedin.com/in/x", "https://linkedin.com/in/x"],
    ["https://www.linkedin.com/in/x/", "https://www.linkedin.com/in/x/"],
    ["https://uk.linkedin.com/in/x", "https://uk.linkedin.com/in/x"],
  ])("accepts %s", (raw, expected) => {
    expect(parseLinkedinUrl(raw)).toBe(expected);
  });

  it.each([
    "http://www.linkedin.com/in/x", // not https
    "javascript:alert(1)",
    "https://linkedin.com.evil.test/in/x", // lookalike host
    "https://evillinkedin.com/in/x", // suffix without the dot
    "https://user:pass@www.linkedin.com/in/x", // credentials in the URL
    "www.linkedin.com/in/x", // no scheme
    "",
  ])("rejects %s", (raw) => {
    expect(parseLinkedinUrl(raw)).toBeNull();
  });
});

describe("messageInputSchema", () => {
  const ok = {
    direction: "OUT",
    type: "COLD",
    channel: "EMAIL",
    subject: " Hi ",
    body: "Hello\n",
    sentAt: "2026-09-25T16:00:00.000Z",
  } as const;

  it("parses a message, trimming the subject and keeping the body as typed", async () => {
    const { messageInputSchema } = await import("@/lib/networking/schema");
    const m = messageInputSchema.parse(ok);
    expect(m).toMatchObject({ subject: "Hi", body: "Hello\n", listingId: null });
    expect(m.sentAt).toEqual(new Date("2026-09-25T16:00:00.000Z"));
  });

  it.each([
    [{ direction: "IN", type: "COLD" }, /isn't a message you can log/],
    [{ direction: "OUT", type: "ACCEPTED", channel: "LINKEDIN" }, /isn't a message you can log/],
    [{ type: "CONNECT_NOTE", channel: "EMAIL" }, /can't be sent by EMAIL/],
    [{ type: "MEETING", channel: "EMAIL" }, /can't be sent by EMAIL/],
    // Openers only on the channels the engine runs a cadence for.
    [{ type: "COLD", channel: "OTHER" }, /can't be sent by OTHER/],
    [{ type: "REFERRAL_ASK", channel: "OTHER" }, /can't be sent by OTHER/],
    [{ sentAt: "yesterday" }, /./],
    [{ sentAt: "2099-01-01T00:00:00Z" }, /future/],
  ])("rejects %o", async (over, message) => {
    const { messageInputSchema } = await import("@/lib/networking/schema");
    const r = messageInputSchema.safeParse({ ...ok, ...over });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues[0].message).toMatch(message);
  });

  it("accepts an inbound acceptance with an empty body", async () => {
    const { messageInputSchema } = await import("@/lib/networking/schema");
    expect(
      messageInputSchema.safeParse({ direction: "IN", type: "ACCEPTED", channel: "LINKEDIN", sentAt: ok.sentAt }).success,
    ).toBe(true);
  });
});
