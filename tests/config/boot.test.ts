import { describe, expect, it } from "vitest";
import { ambientAnthropicCredentials, assertNoAmbientAnthropicCredentials } from "@/lib/env-guard";

describe("assertNoAmbientAnthropicCredentials", () => {
  it("passes when neither ambient variable is set", () => {
    expect(() => assertNoAmbientAnthropicCredentials({ SCORING_ANTHROPIC_API_KEY: "sk-ant-x" })).not.toThrow();
  });

  it("treats blank values as unset (compose renders ${VAR:-} as empty)", () => {
    expect(() => assertNoAmbientAnthropicCredentials({ ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "  " })).not.toThrow();
  });

  it("fails when ANTHROPIC_API_KEY is set", () => {
    expect(() => assertNoAmbientAnthropicCredentials({ ANTHROPIC_API_KEY: "sk-ant-x" })).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("fails when ANTHROPIC_AUTH_TOKEN is set", () => {
    expect(() => assertNoAmbientAnthropicCredentials({ ANTHROPIC_AUTH_TOKEN: "tok" })).toThrow(/ANTHROPIC_AUTH_TOKEN/);
  });

  it("names both when both are set, and never echoes the values", () => {
    expect(ambientAnthropicCredentials({ ANTHROPIC_API_KEY: "a", ANTHROPIC_AUTH_TOKEN: "b" })).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
    expect(() =>
      assertNoAmbientAnthropicCredentials({ ANTHROPIC_API_KEY: "sk-ant-secret-value" }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining("sk-ant-secret-value") }));
  });
});
