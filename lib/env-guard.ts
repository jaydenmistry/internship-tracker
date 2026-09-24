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

export function assertNoAmbientAnthropicCredentials(env: Readonly<Record<string, string | undefined>> = process.env): void {
  const found = ambientAnthropicCredentials(env);
  if (found.length === 0) return;
  throw new Error(
    `${found.join(" and ")} must not be set. The scoring key is read from ` +
      `SCORING_ANTHROPIC_API_KEY; an ambient Anthropic credential would be picked ` +
      `up by clients that are meant to use something else. Rename or unset it.`,
  );
}
