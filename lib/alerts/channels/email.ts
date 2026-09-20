import type { AlertChannelSender, BuiltAlert, ChannelResolution } from "../types";

/**
 * Email delivery over SMTP (nodemailer).
 *
 * Credentials come from SMTP_USER / SMTP_PASS and stay in this module: they are
 * never logged, never returned from a Server Action, and never persisted.
 * The transport is injectable so tests never open a socket, and nodemailer is
 * imported lazily so merely importing the alerts package does not load it.
 */

/** The slice of nodemailer's transport this module uses. */
export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
}

/**
 * What nodemailer reports back. Only `rejected` matters here: it lists the
 * recipients the server refused, and a send is not a success while it is
 * non-empty.
 */
export interface MailResult {
  rejected?: unknown[];
  [key: string]: unknown;
}

export interface MailTransport {
  sendMail(message: MailMessage): Promise<MailResult | undefined>;
}

/**
 * A plain string map rather than NodeJS.ProcessEnv: Next augments that type
 * with required keys, which makes a test fixture impossible to write.
 */
export type EnvLike = Record<string, string | undefined>;

export interface EmailOptions {
  /** Injected in tests; otherwise built from SMTP_* on first send. */
  transport?: MailTransport;
  env?: EnvLike;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  from: string;
  to: string;
  auth: { user: string; pass: string } | null;
}

/**
 * Reads SMTP_* into a config, or explains what is missing. Pure, so the UI can
 * report "email is not configured" without attempting a connection.
 */
export function readSmtpConfig(env: EnvLike = process.env):
  | { ok: true; config: SmtpConfig }
  | { ok: false; reason: string } {
  const get = (key: string) => (env[key] ?? "").trim();

  const missing = ["SMTP_HOST", "SMTP_FROM", "SMTP_TO"].filter((k) => get(k) === "");
  if (missing.length > 0) return { ok: false, reason: `${missing.join(", ")} not set` };

  const rawPort = get("SMTP_PORT");
  const port = rawPort === "" ? 587 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, reason: `SMTP_PORT is not a valid port: ${rawPort}` };
  }

  const rawSecure = get("SMTP_SECURE").toLowerCase();
  // Implicit TLS is the norm on 465 and STARTTLS everywhere else, so the port
  // picks the default and SMTP_SECURE only exists to override it.
  const secure = rawSecure === "" ? port === 465 : rawSecure === "true" || rawSecure === "1";

  const user = get("SMTP_USER");
  const pass = env.SMTP_PASS ?? "";
  // An unauthenticated relay is legitimate (a local MTA), but half a credential
  // is always a misconfiguration and would fail at connect time with a much
  // worse message.
  if ((user === "") !== (pass === "")) {
    return { ok: false, reason: "SMTP_USER and SMTP_PASS must be set together" };
  }

  return {
    ok: true,
    config: {
      host: get("SMTP_HOST"),
      port,
      secure,
      from: get("SMTP_FROM"),
      to: get("SMTP_TO"),
      auth: user === "" ? null : { user, pass },
    },
  };
}

/**
 * The one send implementation, shared by the real SMTP path and the injected
 * transport the tests use. Kept single deliberately: when each path had its
 * own copy, the tests exercised a `send` that production never ran.
 */
function mailSender(
  resolveTransport: () => Promise<MailTransport>,
  from: string,
  to: string,
): AlertChannelSender {
  return {
    channel: "EMAIL",
    async send(alert: BuiltAlert): Promise<void> {
      const transport = await resolveTransport();
      const info = await transport.sendMail({ from, to, subject: alert.subject, text: alert.text });
      // nodemailer resolves when SOME recipients were accepted and rejects
      // only when every one failed. A partial failure resolving quietly would
      // let the caller write AlertLog and dedupe this alert away forever for a
      // recipient who never received it.
      const rejected = info?.rejected ?? [];
      if (rejected.length > 0) {
        throw new Error(`SMTP rejected ${rejected.length} recipient(s): ${rejected.join(", ")}`);
      }
    },
  };
}

export function createEmailChannel(opts: EmailOptions = {}): ChannelResolution {
  // An injected transport is the test path: it stands in for the whole SMTP
  // config, so the environment is not consulted at all.
  if (opts.transport) {
    const transport = opts.transport;
    const env = opts.env ?? process.env;
    return {
      ok: true,
      sender: mailSender(
        async () => transport,
        env.SMTP_FROM ?? "alerts@localhost",
        env.SMTP_TO ?? "alerts@localhost",
      ),
    };
  }

  const read = readSmtpConfig(opts.env);
  if (!read.ok) return { ok: false, reason: read.reason };
  const config = read.config;

  let cached: MailTransport | null = null;
  const transportFor = async (): Promise<MailTransport> => {
    if (cached) return cached;
    const { createTransport } = await import("nodemailer");
    cached = createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: config.auth ?? undefined,
    }) as unknown as MailTransport;
    return cached;
  };

  return { ok: true, sender: mailSender(transportFor, config.from, config.to) };
}
