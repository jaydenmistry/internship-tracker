// Runs once when the Next.js server starts, before it serves a request.
// A throw here stops the app from coming up, which is the point: see
// lib/env-guard.ts for why an ambient Anthropic credential is fatal.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertNoAmbientAnthropicCredentials, reportMissingScoringKey } = await import("@/lib/env-guard");
    assertNoAmbientAnthropicCredentials();
    reportMissingScoringKey(process.env, console.error, "app");
  }
}
