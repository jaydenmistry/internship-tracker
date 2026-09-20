import "dotenv/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate, tested from the deny side.
 *
 * A successful sign-in needs a live Authentik tenant and cannot be exercised
 * here. Refusal can, and refusal is the direction that matters: the failure
 * that costs something is "a stranger got in", not "the owner had to retry".
 */

// lib/auth.ts builds a real NextAuth instance at import; the guard only ever
// calls `auth()`, so stubbing that one function keeps these tests pure.
const authMock = vi.fn<() => Promise<{ user?: { email?: string | null } } | null>>();
vi.mock("@/lib/auth", () => ({
  auth: () => authMock(),
  handlers: {},
  signIn: vi.fn(),
  signOut: vi.fn(),
}));

const ORIGINAL = process.env.ALLOWED_EMAIL;

beforeEach(() => {
  authMock.mockReset();
  process.env.ALLOWED_EMAIL = "owner@example.com";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOWED_EMAIL;
  else process.env.ALLOWED_EMAIL = ORIGINAL;
});

describe("isAllowedEmail — fails closed", () => {
  it("admits nobody when ALLOWED_EMAIL is unset or blank", async () => {
    const { isAllowedEmail } = await import("@/lib/auth.config");

    delete process.env.ALLOWED_EMAIL;
    expect(isAllowedEmail("owner@example.com")).toBe(false);

    process.env.ALLOWED_EMAIL = "   ";
    // The dangerous reading of "no allowlist configured" is "allow everyone".
    expect(isAllowedEmail("owner@example.com")).toBe(false);
    expect(isAllowedEmail("anyone@example.com")).toBe(false);
  });

  it("admits only the configured address, ignoring case and surrounding space", async () => {
    const { isAllowedEmail } = await import("@/lib/auth.config");
    expect(isAllowedEmail("owner@example.com")).toBe(true);
    expect(isAllowedEmail("  Owner@Example.COM ")).toBe(true);
    expect(isAllowedEmail("someone.else@example.com")).toBe(false);
    // A missing email on the profile is not a match for a blank allowlist.
    expect(isAllowedEmail(null)).toBe(false);
    expect(isAllowedEmail(undefined)).toBe(false);
    expect(isAllowedEmail("")).toBe(false);
  });
});

describe("isPublicPath — exact, not prefix", () => {
  it("opens exactly the sign-in handshake, the sign-in page and the healthcheck", async () => {
    const { isPublicPath } = await import("@/lib/auth.config");
    expect(isPublicPath("/signin")).toBe(true);
    expect(isPublicPath("/api/health")).toBe(true);
    expect(isPublicPath("/api/auth")).toBe(true);
    expect(isPublicPath("/api/auth/callback/authentik")).toBe(true);
  });

  it("does not open a path that merely starts with a public one", async () => {
    const { isPublicPath } = await import("@/lib/auth.config");
    // The bug this guards: `startsWith("/api/health")` would open all of these.
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/api/health/../applications/export")).toBe(false);
    expect(isPublicPath("/signin-as-admin")).toBe(false);
    expect(isPublicPath("/signinx")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/applications/export")).toBe(false);
    expect(isPublicPath("/tracker")).toBe(false);
  });
});

/**
 * Enumerated on purpose. A new Server Action added without a guard fails this
 * test by existing — which is the only reliable protection against forgetting
 * one line at the top of a function.
 */
const ACTION_MODULES = [
  "@/app/listings/actions",
  "@/app/tracker/actions",
  "@/app/import/actions",
  "@/app/resume/actions",
  "@/app/alerts/actions",
] as const;

describe("every Server Action refuses an unauthenticated caller", () => {
  for (const specifier of ACTION_MODULES) {
    it(`${specifier} — all exports reject with no session`, async () => {
      authMock.mockResolvedValue(null);
      const mod: Record<string, unknown> = await import(specifier);
      const actions = Object.entries(mod).filter(
        ([, v]) => typeof v === "function",
      ) as Array<[string, (...a: unknown[]) => Promise<unknown>]>;

      // If this module stops exporting actions, the assertions below would pass
      // vacuously and the guard would be untested.
      expect(actions.length).toBeGreaterThan(0);

      for (const [name, fn] of actions) {
        await expect(
          fn({}),
          `${name} resolved instead of refusing an unauthenticated call`,
        ).rejects.toThrow(/not signed in/i);
      }
    });
  }

  it("also refuses a session whose email is no longer the allowed one", async () => {
    // A token minted before ALLOWED_EMAIL changed must stop working, rather
    // than living out its natural life.
    authMock.mockResolvedValue({ user: { email: "former-owner@example.com" } });
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).rejects.toThrow(/not signed in/i);
  });

  it("admits the configured owner", async () => {
    authMock.mockResolvedValue({ user: { email: "owner@example.com" } });
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).resolves.toEqual({ email: "owner@example.com" });
  });
});
