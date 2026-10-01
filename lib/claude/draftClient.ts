import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * The drafting client: one locked-down, single-turn call to Claude through
 * the Claude Agent SDK, authenticated with YOUR Claude subscription
 * (CLAUDE_CODE_OAUTH_TOKEN, from `claude setup-token`) — not the scoring key.
 *
 * Scoring keeps its own Anthropic-SDK client and API key (lib/scoring/llm.ts).
 * The two must never cross: Claude Code prefers ANTHROPIC_AUTH_TOKEN and
 * ANTHROPIC_API_KEY over an OAuth token, so a stray API key in this process's
 * environment would silently move drafts onto API billing. Three layers stop
 * that — the renamed scoring key, the boot check (lib/env-guard.ts), and the
 * allowlisted environment built here, which the SDK uses INSTEAD of
 * process.env.
 *
 * Personal use only: subscription auth covers one person's own use. If this
 * app is ever opened to anyone else, drafting must move to an API key first.
 */

/** Pinned exactly in package.json; option names change between versions. */
export const AGENT_SDK_VERSION = "0.3.283";

export const DEFAULT_DRAFT_MODEL = "claude-sonnet-5";
export const DEFAULT_DRAFT_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DraftErrorKind = "NotAuthenticated" | "UsageLimited" | "Timeout" | "BadOutput";

export class DraftClientError extends Error {
  constructor(
    readonly kind: DraftErrorKind,
    message: string,
    /** For UsageLimited: when the limit resets, if Claude said. */
    readonly resetsAt: Date | null = null,
  ) {
    super(message);
    this.name = "DraftClientError";
  }
}

// ---------------------------------------------------------------------------
// The locked-down options (pure, unit-tested)
// ---------------------------------------------------------------------------

/**
 * The ONLY environment variables the Claude Code subprocess gets. When `env`
 * is set the SDK uses it in place of process.env (not merged), so nothing
 * else — the scoring key, DATABASE_URL, SMTP_PASS — can reach it.
 */
export const DRAFT_ENV_ALLOWLIST = ["PATH", "HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/**
 * Constant hardening flags — set to fixed values, never inherited, so they
 * add no way in for a secret. Attachments off is the second lock behind
 * `verbatimPrompts` (no `@path` file expansion); non-essential traffic off
 * keeps the subprocess to the one model request.
 */
export const DRAFT_ENV_HARDENING = {
  CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
} as const;

export function buildDraftEnv(
  source: Readonly<Record<string, string | undefined>>,
  configDir: string,
): Record<string, string> {
  const token = (source.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim();
  if (token === "") throw new DraftClientError("NotAuthenticated", "CLAUDE_CODE_OAUTH_TOKEN is not set");
  return {
    PATH: source.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    // HOME and CLAUDE_CONFIG_DIR both point at a fresh per-call directory, so
    // Claude Code reads no real ~/.claude (settings, memory, credentials) and
    // whatever it writes there is deleted when the call ends.
    HOME: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_CODE_OAUTH_TOKEN: token,
    ...DRAFT_ENV_HARDENING,
  };
}

export interface QueryOptionsInput {
  model: string;
  systemPrompt: string;
  /** An empty directory: the session's working directory. */
  cwd: string;
  env: Record<string, string>;
  abortController?: AbortController;
}

/** Denies every tool call. Unreachable with `tools: []` — a second lock. */
const denyAllTools: NonNullable<Options["canUseTool"]> = async () => ({
  behavior: "deny",
  message: "Drafting runs with no tools.",
});

export function buildQueryOptions(input: QueryOptionsInput): Options {
  return {
    model: input.model,
    // Replaces Claude Code's default system prompt entirely.
    systemPrompt: { type: "custom", prompt: input.systemPrompt },
    // The prompt is assembled from text the user didn't type (scraped
    // postings, pasted replies). Without this the CLI expands `@path` file
    // mentions and dispatches slash commands in it — with NO tools needed —
    // so a posting containing " @/proc/1/environ" could pull the app's
    // secrets into the draft. Verbatim: delivered exactly as written.
    verbatimPrompts: true,
    // No built-in tools at all, nothing auto-allowed, anything asked denied.
    tools: [],
    allowedTools: [],
    permissionMode: "dontAsk",
    canUseTool: denyAllTools,
    // No MCP servers, and ignore any .mcp.json / user / plugin MCP config.
    mcpServers: {},
    strictMcpConfig: true,
    // No skills, plugins, subagents or hooks.
    skills: [],
    plugins: [],
    agents: {},
    hooks: {},
    // One turn: the model answers once and the session ends.
    maxTurns: 1,
    // Load NO filesystem settings: the repo's CLAUDE.md and .claude/ can't
    // leak into the prompt, and no user settings can re-enable anything.
    settingSources: [],
    // No transcript on disk: prompts contain third-party contact data.
    persistSession: false,
    cwd: input.cwd,
    env: input.env,
    ...(input.abortController ? { abortController: input.abortController } : {}),
  };
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

export interface DraftRequest {
  system: string;
  prompt: string;
}

export interface DraftClient {
  /** Resolves to the model's text; rejects with a DraftClientError. */
  complete(req: DraftRequest): Promise<string>;
}

type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface DraftClientOptions {
  model?: string;
  timeoutMs?: number;
  env?: Readonly<Record<string, string | undefined>>;
  /** Injected in tests; defaults to the SDK's query(). */
  queryImpl?: QueryFn;
}

const AUTH_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
]);

/** Is the subscription token configured at all? (Not whether it's valid.) */
export function draftingConfigured(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return (env.CLAUDE_CODE_OAUTH_TOKEN ?? "").trim() !== "";
}

export function createDraftClient(opts: DraftClientOptions = {}): DraftClient {
  const model = opts.model ?? DEFAULT_DRAFT_MODEL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAFT_TIMEOUT_MS;
  const sourceEnv = opts.env ?? process.env;

  return {
    async complete(req) {
      // Checked before any directory is made or process spawned.
      buildDraftEnv(sourceEnv, "/nonexistent");

      const root = await mkdtemp(path.join(tmpdir(), "tracker-draft-"));
      const cwd = path.join(root, "cwd");
      const configDir = path.join(root, "config");
      const abortController = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
      }, timeoutMs);

      try {
        await mkdir(cwd);
        await mkdir(configDir);
        const options = buildQueryOptions({
          model,
          systemPrompt: req.system,
          cwd,
          env: buildDraftEnv(sourceEnv, configDir),
          abortController,
        });
        const query: QueryFn = opts.queryImpl ?? (await import("@anthropic-ai/claude-agent-sdk")).query;

        let limit: DraftClientError | null = null;
        for await (const msg of query({ prompt: req.prompt, options })) {
          if (msg.type === "rate_limit_event" && msg.rate_limit_info.status === "rejected") {
            const at = msg.rate_limit_info.resetsAt;
            limit = new DraftClientError(
              "UsageLimited",
              "Your Claude plan's usage limit has been reached.",
              typeof at === "number" ? new Date(at * 1000) : null,
            );
          } else if (msg.type === "assistant" && msg.error) {
            if (AUTH_ERRORS.has(msg.error)) {
              throw new DraftClientError("NotAuthenticated", `Claude rejected the subscription token (${msg.error}).`);
            }
            if (msg.error === "rate_limit") {
              limit ??= new DraftClientError("UsageLimited", "Your Claude plan's usage limit has been reached.");
            }
          } else if (msg.type === "result") {
            if (limit) throw limit;
            if (msg.subtype !== "success" || msg.is_error) {
              throw new DraftClientError(
                "BadOutput",
                `Claude didn't finish the draft (${msg.subtype}${
                  "errors" in msg && msg.errors.length ? `: ${msg.errors.join("; ").slice(0, 300)}` : ""
                }).`,
              );
            }
            return msg.result;
          }
        }
        if (limit) throw limit;
        throw new DraftClientError("BadOutput", "Claude ended without a result.");
      } catch (err) {
        if (timedOut) throw new DraftClientError("Timeout", `No draft within ${Math.round(timeoutMs / 1000)}s.`);
        if (err instanceof DraftClientError) throw err;
        throw new DraftClientError("BadOutput", `Drafting failed: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearTimeout(timer);
        // The config dir may hold whatever Claude Code wrote during the call;
        // none of it outlives the call.
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}
