import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  AGENT_SDK_VERSION,
  buildDraftEnv,
  buildQueryOptions,
  createDraftClient,
  DRAFT_ENV_ALLOWLIST,
  DRAFT_ENV_HARDENING,
  DraftClientError,
  draftingConfigured,
} from "@/lib/claude/draftClient";
import pkg from "@/package.json";

const SECRET_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/real",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
  ANTHROPIC_API_KEY: "sk-ant-ambient",
  ANTHROPIC_AUTH_TOKEN: "bearer",
  SCORING_ANTHROPIC_API_KEY: "sk-ant-scoring",
  DATABASE_URL: "postgres://secret",
  SMTP_PASS: "hunter2",
};

describe("buildQueryOptions — the lockdown", () => {
  const options = buildQueryOptions({
    model: "claude-sonnet-5",
    systemPrompt: "SYSTEM",
    cwd: "/tmp/empty",
    env: { PATH: "/usr/bin" },
  });

  it("has no tools, nothing auto-allowed, and denies anything asked", async () => {
    expect(options.tools).toEqual([]);
    expect(options.allowedTools).toEqual([]);
    expect(options.permissionMode).toBe("dontAsk");
    await expect(
      options.canUseTool!("Bash", {}, { signal: new AbortController().signal } as Parameters<
        NonNullable<Options["canUseTool"]>
      >[2]),
    ).resolves.toMatchObject({ behavior: "deny" });
  });

  it("has no MCP servers and ignores all on-disk MCP config", () => {
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
  });

  it("is a single turn, with no skills, plugins, subagents or hooks", () => {
    expect(options.maxTurns).toBe(1);
    expect(options.skills).toEqual([]);
    expect(options.plugins).toEqual([]);
    expect(options.agents).toEqual({});
    expect(options.hooks).toEqual({});
  });

  it("loads no filesystem settings and persists no transcript", () => {
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
  });

  it("delivers the prompt verbatim: no @path file expansion, no slash commands", () => {
    // tools: [] does NOT stop the CLI expanding "@/path" mentions into
    // context; only this does (SDK 0.3.283 docs for verbatimPrompts).
    expect(options.verbatimPrompts).toBe(true);
  });

  it("replaces the system prompt, and uses the given model, cwd and env", () => {
    expect(options.systemPrompt).toEqual({ type: "custom", prompt: "SYSTEM" });
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.cwd).toBe("/tmp/empty");
    expect(options.env).toEqual({ PATH: "/usr/bin" });
  });

  it("sets nothing that could widen it (no resume, no extra dirs, no settings, no bypass)", () => {
    for (const key of [
      "additionalDirectories",
      "settings",
      "managedSettings",
      "extraArgs",
      "resume",
      "continue",
      "allowDangerouslySkipPermissions",
      "pathToClaudeCodeExecutable",
      "spawnClaudeCodeProcess",
    ]) {
      expect(options, key).not.toHaveProperty(key);
    }
  });
});

describe("buildDraftEnv — the allowlisted environment", () => {
  it("passes ONLY the allowlist plus fixed hardening flags, with HOME and the config dir pointed at the per-call dir", () => {
    const env = buildDraftEnv(SECRET_ENV, "/tmp/call/config");
    expect(Object.keys(env).sort()).toEqual([...DRAFT_ENV_ALLOWLIST, ...Object.keys(DRAFT_ENV_HARDENING)].sort());
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/tmp/call/config",
      CLAUDE_CONFIG_DIR: "/tmp/call/config",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-test",
      CLAUDE_CODE_DISABLE_ATTACHMENTS: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
  });

  it("hardening flags are constants — a same-named variable in the source env can't change them", () => {
    const env = buildDraftEnv({ ...SECRET_ENV, CLAUDE_CODE_DISABLE_ATTACHMENTS: "0" }, "/tmp/x");
    expect(env.CLAUDE_CODE_DISABLE_ATTACHMENTS).toBe("1");
  });

  it("never carries an Anthropic API key, bearer token, the scoring key or app secrets", () => {
    const env = buildDraftEnv(SECRET_ENV, "/tmp/x");
    for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "SCORING_ANTHROPIC_API_KEY", "DATABASE_URL", "SMTP_PASS"]) {
      expect(env, key).not.toHaveProperty(key);
    }
    expect(JSON.stringify(env)).not.toMatch(/sk-ant-ambient|sk-ant-scoring|hunter2|postgres:/);
  });

  it("refuses without a subscription token", () => {
    expect(() => buildDraftEnv({ PATH: "/usr/bin" }, "/tmp/x")).toThrow(DraftClientError);
    expect(draftingConfigured({})).toBe(false);
    expect(draftingConfigured({ CLAUDE_CODE_OAUTH_TOKEN: " " })).toBe(false);
    expect(draftingConfigured({ CLAUDE_CODE_OAUTH_TOKEN: "t" })).toBe(true);
  });
});

describe("the pinned SDK", () => {
  it("package.json pins the exact version the options were checked against", () => {
    const deps = (pkg as { dependencies: Record<string, string> }).dependencies;
    expect(deps["@anthropic-ai/claude-agent-sdk"]).toBe(AGENT_SDK_VERSION);
  });
});

// ---------------------------------------------------------------------------
// createDraftClient with a fake query() — no network, no subprocess
// ---------------------------------------------------------------------------

type Fake = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

function fake(messages: Array<Partial<SDKMessage> & { type: string }>, seen?: Array<{ prompt: string; options?: Options }>): Fake {
  return (params) => {
    seen?.push(params);
    return (async function* () {
      for (const m of messages) yield m as SDKMessage;
    })();
  };
}

const success = (result: string) => ({ type: "result", subtype: "success", is_error: false, result }) as const;
const env = { PATH: "/usr/bin", CLAUDE_CODE_OAUTH_TOKEN: "tok", ANTHROPIC_API_KEY: "leak" };

describe("createDraftClient", () => {
  it("returns the result text, calling query() with the locked options in an empty temp dir", async () => {
    const seen: Array<{ prompt: string; options?: Options }> = [];
    const client = createDraftClient({ env, queryImpl: fake([success('{"body":"hi"}')], seen) });
    await expect(client.complete({ system: "S", prompt: "P" })).resolves.toBe('{"body":"hi"}');

    const { prompt, options } = seen[0];
    expect(prompt).toBe("P");
    expect(options?.tools).toEqual([]);
    expect(options?.maxTurns).toBe(1);
    expect(options?.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(options?.env?.HOME).toBe(options?.env?.CLAUDE_CONFIG_DIR);
    // The per-call directories are gone once the call returns.
    expect(existsSync(options!.cwd!)).toBe(false);
    expect(existsSync(options!.env!.HOME!)).toBe(false);
  });

  it("maps an auth failure to NotAuthenticated", async () => {
    const client = createDraftClient({ env, queryImpl: fake([{ type: "assistant", error: "authentication_failed" }]) });
    await expect(client.complete({ system: "S", prompt: "P" })).rejects.toMatchObject({ kind: "NotAuthenticated" });
  });

  it("maps a rejected rate limit to UsageLimited, with the reset time", async () => {
    const client = createDraftClient({
      env,
      queryImpl: fake([
        { type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1_790_000_000 } },
        { type: "result", subtype: "error_during_execution", is_error: true, errors: ["limit"] },
      ] as never),
    });
    const err = await client.complete({ system: "S", prompt: "P" }).catch((e) => e);
    expect(err).toMatchObject({ kind: "UsageLimited" });
    expect((err as DraftClientError).resetsAt).toEqual(new Date(1_790_000_000_000));
  });

  it("ignores an allowed / warning rate-limit event", async () => {
    const client = createDraftClient({
      env,
      queryImpl: fake([
        { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } },
        success("ok"),
      ] as never),
    });
    await expect(client.complete({ system: "S", prompt: "P" })).resolves.toBe("ok");
  });

  it("maps a non-success result, or no result at all, to BadOutput", async () => {
    const bad = createDraftClient({
      env,
      queryImpl: fake([{ type: "result", subtype: "error_max_turns", is_error: true, errors: [] }] as never),
    });
    await expect(bad.complete({ system: "S", prompt: "P" })).rejects.toMatchObject({ kind: "BadOutput" });
    const none = createDraftClient({ env, queryImpl: fake([]) });
    await expect(none.complete({ system: "S", prompt: "P" })).rejects.toMatchObject({ kind: "BadOutput" });
  });

  it("aborts and reports Timeout when Claude takes too long", async () => {
    let aborted = false;
    const hang: Fake = ({ options }) =>
      (async function* () {
        await new Promise<void>((resolve) => {
          options!.abortController!.signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });
        throw new Error("aborted");
      })();
    const client = createDraftClient({ env, timeoutMs: 50, queryImpl: hang });
    await expect(client.complete({ system: "S", prompt: "P" })).rejects.toMatchObject({ kind: "Timeout" });
    expect(aborted).toBe(true);
  });

  it("refuses before spawning anything when no token is configured", async () => {
    const seen: Array<{ prompt: string }> = [];
    const client = createDraftClient({ env: { PATH: "/usr/bin" }, queryImpl: fake([success("x")], seen) });
    await expect(client.complete({ system: "S", prompt: "P" })).rejects.toMatchObject({ kind: "NotAuthenticated" });
    expect(seen).toHaveLength(0);
  });
});
