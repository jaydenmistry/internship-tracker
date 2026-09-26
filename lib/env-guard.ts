/**
 * Refuse to boot with an ambient Anthropic credential in the environment.
 *
 * The scoring key lives in SCORING_ANTHROPIC_API_KEY and is handed to the
 * Anthropic SDK explicitly (lib/scoring/llm.ts). The names below are the ones
 * SDKs and Claude Code pick up *on their own*: Claude Code prefers an API key
 * over a subscription token when both are present, so a stray
 * ANTHROPIC_API_KEY would quietly move networking drafts from the Claude plan
 * onto API billing. Failing at boot makes that a loud config error instead.
 *
 * Blank values count as unset, the same way every other optional key here is
 * read — compose renders `${VAR:-}` as an empty string.
 */
export const FORBIDDEN_AMBIENT_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

export function ambientAnthropicCredentials(env: Readonly<Record<string, string | undefined>>): string[] {
  return FORBIDDEN_AMBIENT_VARS.filter((name) => (env[name] ?? "").trim() !== "");
}

/**
 * Stage-2 scoring is optional, so a missing key must not stop either process —
 * but it silently turns every new posting into rule-only scoring, which is
 * easy to miss. Especially right after the rename from ANTHROPIC_API_KEY, when
 * an un-renamed .env is the likeliest cause. Returns whether it logged.
 */
export function reportMissingScoringKey(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (message: string) => void = console.error,
  processName = "app",
): boolean {
  if ((env.SCORING_ANTHROPIC_API_KEY ?? "").trim() !== "") return false;
  log(
    `[${processName}] SCORING_ANTHROPIC_API_KEY is not set — stage-2 Claude scoring is DISABLED ` +
      `(rule-based scores only; cached assessments still apply). If this deployment used ` +
      `ANTHROPIC_API_KEY before, rename it (host .env: TRACKER_SCORING_ANTHROPIC_API_KEY).`,
  );
  return true;
}

/**
 * APP_URL must be an absolute http(s) origin ("https://jobs.example.com").
 * Without the scheme the digest builder can't make a link from it and falls
 * back to bare paths — easy to miss, so say so at startup. Returns whether
 * it logged. Unset is fine (links are paths).
 */
export function reportBadAppUrl(
  env: Readonly<Record<string, string | undefined>> = process.env,
  log: (message: string) => void = console.error,
  processName = "app",
): boolean {
  const raw = (env.APP_URL ?? "").trim();
  if (raw === "") return false;
  let ok = false;
  try {
    const u = new URL(raw);
    ok = (u.protocol === "https:" || u.protocol === "http:") && u.host !== "";
  } catch {
    ok = false;
  }
  if (ok) return false;
  log(
    `[${processName}] APP_URL must be an absolute http(s) origin like https://jobs.example.com — ` +
      `digest follow-up links will be bare paths until it is fixed.`,
  );
  return true;
}

export function assertNoAmbientAnthropicCredentials(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const found = ambientAnthropicCredentials(env);
  if (found.length === 0) return;
  throw new Error(
    `${found.join(" and ")} must not be set. The scoring key is read from ` +
      `SCORING_ANTHROPIC_API_KEY; an ambient Anthropic credential would be picked ` +
      `up by clients that are meant to use something else. Rename or unset it.`,
  );
}
