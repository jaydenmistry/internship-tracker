import { describe, expect, it, vi } from "vitest";
import { createDiscordChannel, truncateForDiscord, DISCORD_CONTENT_LIMIT } from "@/lib/alerts/channels/discord";
import { createEmailChannel, readSmtpConfig } from "@/lib/alerts/channels/email";
import type { BuiltAlert } from "@/lib/alerts/types";

/**
 * Channel resolution and payload shape. Both transports are injected, so this
 * file opens no socket: `fetch` is a spy and the mail transport is a stub.
 */

const alert: BuiltAlert = {
  kind: "HIGH_SCORE",
  baseKey: "l1",
  listingId: "l1",
  listingIds: ["l1"],
  subject: "High match 92: Acme — SWE Intern",
  text: "plain body",
  discord: "**discord body**",
};

describe("discord channel", () => {
  it("is unavailable, not an error, when the webhook is unset", () => {
    const result = createDiscordChannel({ webhookUrl: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("DISCORD_WEBHOOK_URL");
  });

  it("refuses a non-https webhook", () => {
    const plain = createDiscordChannel({ webhookUrl: "http://discord.test/hook" });
    const junk = createDiscordChannel({ webhookUrl: "not-a-url" });
    expect(plain.ok).toBe(false);
    expect(junk.ok).toBe(false);
  });

  it("posts the discord body with every mention suppressed", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
    const result = createDiscordChannel({
      webhookUrl: "https://discord.test/api/webhooks/1/token",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    await result.sender.send(alert);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://discord.test/api/webhooks/1/token");
    const body = JSON.parse(String(init.body));
    expect(body.content).toBe("**discord body**");
    // Scraped titles reach this body; escaping markdown does not stop an
    // @everyone, so mentions are disabled at the API level.
    expect(body.allowed_mentions).toEqual({ parse: [] });
  });

  it("throws with the status when Discord rejects the post", async () => {
    const fetchImpl = vi.fn(async () => new Response("rate limited", { status: 429 }));
    const result = createDiscordChannel({
      webhookUrl: "https://discord.test/hook",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    if (!result.ok) throw new Error("expected a sender");

    await expect(result.sender.send(alert)).rejects.toThrow(/429/);
  });

  it("truncates a body over the Discord limit", () => {
    const long = "x".repeat(DISCORD_CONTENT_LIMIT + 500);
    const out = truncateForDiscord(long);
    expect(out.length).toBeLessThanOrEqual(DISCORD_CONTENT_LIMIT);
    expect(out.endsWith("(truncated)")).toBe(true);
    expect(truncateForDiscord("short")).toBe("short");
  });
});

describe("email channel", () => {
  const base = {
    SMTP_HOST: "smtp.test",
    SMTP_FROM: "alerts@test",
    SMTP_TO: "me@test",
  };

  it("is unavailable when the host, sender or recipient is missing", () => {
    const result = readSmtpConfig({ SMTP_HOST: "smtp.test" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("SMTP_FROM");
  });

  it("defaults to 587/STARTTLS and switches to implicit TLS on 465", () => {
    const def = readSmtpConfig(base);
    expect(def.ok && def.config.port).toBe(587);
    expect(def.ok && def.config.secure).toBe(false);

    const tls = readSmtpConfig({ ...base, SMTP_PORT: "465" });
    expect(tls.ok && tls.config.secure).toBe(true);

    const forced = readSmtpConfig({ ...base, SMTP_PORT: "2525", SMTP_SECURE: "true" });
    expect(forced.ok && forced.config.secure).toBe(true);
  });

  it("rejects half a credential", () => {
    const result = readSmtpConfig({ ...base, SMTP_USER: "bob" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("together");
  });

  it("allows an unauthenticated relay", () => {
    const result = readSmtpConfig(base);
    expect(result.ok && result.config.auth).toBeNull();
  });

  it("rejects a nonsense port", () => {
    expect(readSmtpConfig({ ...base, SMTP_PORT: "abc" }).ok).toBe(false);
    expect(readSmtpConfig({ ...base, SMTP_PORT: "70000" }).ok).toBe(false);
  });

  it("sends the plain-text body through an injected transport", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "1" }));
    const result = createEmailChannel({ transport: { sendMail }, env: base });
    if (!result.ok) throw new Error("expected a sender");

    await result.sender.send(alert);

    expect(sendMail).toHaveBeenCalledWith({
      from: "alerts@test",
      to: "me@test",
      subject: alert.subject,
      text: alert.text,
    });
  });

  it("treats a partially rejected send as a failure", async () => {
    // nodemailer resolves when SOME recipients were accepted, rejecting only
    // when all of them fail. Resolving quietly here would let the caller write
    // AlertLog and dedupe this alert away forever for a recipient who never
    // received it — the one outcome the send/record ordering exists to prevent.
    const sendMail = vi.fn(async () => ({ messageId: "1", rejected: ["other@test"] }));
    const result = createEmailChannel({ transport: { sendMail }, env: base });
    if (!result.ok) throw new Error("expected a sender");

    await expect(result.sender.send(alert)).rejects.toThrow(/rejected 1 recipient/i);
  });

  it("accepts a send with an empty rejected list", async () => {
    const sendMail = vi.fn(async () => ({ messageId: "1", rejected: [] }));
    const result = createEmailChannel({ transport: { sendMail }, env: base });
    if (!result.ok) throw new Error("expected a sender");

    await expect(result.sender.send(alert)).resolves.toBeUndefined();
  });
});
