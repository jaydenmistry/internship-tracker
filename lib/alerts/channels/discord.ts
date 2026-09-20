import type { BuiltAlert, ChannelResolution } from "../types";

/**
 * Discord delivery over an incoming webhook.
 *
 * The webhook URL is a bearer credential in URL form: it comes from
 * DISCORD_WEBHOOK_URL and is never logged, never returned to the client, and
 * never written to the database. Error messages here carry the HTTP status and
 * the response body, never the URL.
 */

/** Discord rejects a message body over this length outright. */
export const DISCORD_CONTENT_LIMIT = 2000;

export interface DiscordOptions {
  /** Defaults to `process.env.DISCORD_WEBHOOK_URL`. */
  webhookUrl?: string;
  /** Injected in tests so nothing here ever touches the network. */
  fetchImpl?: typeof globalThis.fetch;
}

export function truncateForDiscord(content: string): string {
  if (content.length <= DISCORD_CONTENT_LIMIT) return content;
  const suffix = "\n… (truncated)";
  return `${content.slice(0, DISCORD_CONTENT_LIMIT - suffix.length)}${suffix}`;
}

/**
 * Resolve the channel from the environment. A missing or non-https URL is
 * "unavailable", not an error — the user may only want email.
 */
export function createDiscordChannel(opts: DiscordOptions = {}): ChannelResolution {
  const webhookUrl = (opts.webhookUrl ?? process.env.DISCORD_WEBHOOK_URL ?? "").trim();
  if (webhookUrl === "") return { ok: false, reason: "DISCORD_WEBHOOK_URL is not set" };

  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch {
    return { ok: false, reason: "DISCORD_WEBHOOK_URL is not a valid URL" };
  }
  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "DISCORD_WEBHOOK_URL must be https" };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    ok: true,
    sender: {
      channel: "DISCORD",
      async send(alert: BuiltAlert): Promise<void> {
        const res = await fetchImpl(webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            content: truncateForDiscord(alert.discord),
            // Scraped company and role names end up in the body. Suppressing
            // every mention at the API level is the only defense that holds —
            // escaping markdown does not stop an @everyone in a job title.
            allowed_mentions: { parse: [] },
          }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(
            `Discord webhook returned ${res.status} ${res.statusText}${
              body ? `: ${body.slice(0, 200)}` : ""
            }`,
          );
        }
      },
    },
  };
}
