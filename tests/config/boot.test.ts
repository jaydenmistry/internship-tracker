import { describe, expect, it } from "vitest";
import {
  ambientAnthropicCredentials,
  assertNoAmbientAnthropicCredentials,
  reportBadAppUrl,
  reportMissingScoringKey,
} from "@/lib/env-guard";

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

describe("reportMissingScoringKey", () => {
  it("logs a clear, actionable error when the scoring key is unset or blank", () => {
    for (const env of [{}, { SCORING_ANTHROPIC_API_KEY: "  " }]) {
      const lines: string[] = [];
      expect(reportMissingScoringKey(env, (m) => lines.push(m), "worker")).toBe(true);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^\[worker\] SCORING_ANTHROPIC_API_KEY is not set/);
      expect(lines[0]).toMatch(/stage-2 Claude scoring is DISABLED/);
      expect(lines[0]).toMatch(/TRACKER_SCORING_ANTHROPIC_API_KEY/);
    }
  });

  it("stays quiet when the key is set, and never echoes it", () => {
    const lines: string[] = [];
    expect(reportMissingScoringKey({ SCORING_ANTHROPIC_API_KEY: "sk-ant-x" }, (m) => lines.push(m))).toBe(false);
    expect(lines).toEqual([]);
  });
});

describe("reportBadAppUrl", () => {
  it.each(["https://jobs.example.com", "http://localhost:3000", "", undefined])("accepts %s", (v) => {
    const lines: string[] = [];
    expect(reportBadAppUrl({ APP_URL: v }, (m) => lines.push(m))).toBe(false);
    expect(lines).toEqual([]);
  });

  it.each(["jobs.example.com", "javascript:alert(1)", "ftp://jobs.example.com", "https://"])("flags %s", (v) => {
    const lines: string[] = [];
    expect(reportBadAppUrl({ APP_URL: v }, (m) => lines.push(m), "worker")).toBe(true);
    expect(lines[0]).toMatch(/^\[worker\] APP_URL must be an absolute http\(s\) origin/);
  });
});
