import "dotenv/config";
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate, tested from both sides.
 *
 * With forward-auth the app's whole notion of identity is two request headers,
 * which makes both directions cheap to test here — unlike the OIDC flow this
 * replaced, where only refusal could be exercised without a live provider.
 */

// The guard reads request headers; `next/headers` only works inside a request
// scope, so it is stubbed with whatever a given test wants Authelia to have
// forwarded. lib/auth.ts itself is pure and is NOT mocked.
let currentHeaders = new Headers();
vi.mock("next/headers", () => ({ headers: async () => currentHeaders }));

function forwardedAs(identity: Record<string, string> | null) {
  currentHeaders = new Headers(identity ?? {});
}

const ORIGINAL = process.env.ALLOWED_USER;

beforeEach(() => {
  forwardedAs(null);
  process.env.ALLOWED_USER = "owner@example.com";
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ALLOWED_USER;
  else process.env.ALLOWED_USER = ORIGINAL;
});

describe("isAllowedUser — fails closed", () => {
  it("admits nobody when ALLOWED_USER is unset or blank", async () => {
    const { isAllowedUser } = await import("@/lib/auth");

    delete process.env.ALLOWED_USER;
    expect(isAllowedUser("owner@example.com")).toBe(false);

    process.env.ALLOWED_USER = "   ";
    // The dangerous reading of "no allowlist configured" is "allow everyone".
    expect(isAllowedUser("owner@example.com")).toBe(false);
    expect(isAllowedUser("anyone@example.com")).toBe(false);
  });

  it("admits only the configured address, ignoring case and surrounding space", async () => {
    const { isAllowedUser } = await import("@/lib/auth");
    expect(isAllowedUser("owner@example.com")).toBe(true);
    expect(isAllowedUser("  Owner@Example.COM ")).toBe(true);
    expect(isAllowedUser("someone.else@example.com")).toBe(false);
    // A missing email on the profile is not a match for a blank allowlist.
    expect(isAllowedUser(null)).toBe(false);
    expect(isAllowedUser(undefined)).toBe(false);
    expect(isAllowedUser("")).toBe(false);
  });
});

describe("isPublicPath — exact, not prefix", () => {
  it("opens exactly the healthcheck, and nothing else", async () => {
    const { isPublicPath } = await import("@/lib/auth");
    expect(isPublicPath("/api/health")).toBe(true);
  });

  it("does not open a path that merely starts with a public one", async () => {
    const { isPublicPath } = await import("@/lib/auth");
    // The bug this guards: `startsWith("/api/health")` would open all of these.
    expect(isPublicPath("/api/healthz")).toBe(false);
    expect(isPublicPath("/api/health/../applications/export")).toBe(false);
    expect(isPublicPath("/api/health/status")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
    expect(isPublicPath("/api/applications/export")).toBe(false);
    expect(isPublicPath("/tracker")).toBe(false);
  });
});

/**
 * DISCOVERED, not listed. A hand-written list only catches a new action in a
 * file someone remembered to add here — the failure mode this guards against
 * is precisely the one where nobody remembered. Walking `app/` means a whole
 * new `actions.ts` cannot appear unguarded.
 *
 * Nothing is exempt: with Authelia in front there is no login flow in this
 * app, so there is no action an anonymous caller legitimately needs.
 */
const UNGUARDED_BY_DESIGN: string[] = [];

function discoverActionModules(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...discoverActionModules(full));
    else if (entry.name === "actions.ts") found.push(full);
  }
  return found;
}

const APP_DIR = path.resolve(import.meta.dirname, "../../app");
const ACTION_MODULES = discoverActionModules(APP_DIR)
  .map((f) => path.relative(path.resolve(APP_DIR, ".."), f).replace(/\\/g, "/"))
  .filter((rel) => !UNGUARDED_BY_DESIGN.includes(rel))
  .sort();

describe("every Server Action refuses an unauthenticated caller", () => {
  it("found the action modules to check", () => {
    // If discovery silently returns nothing, every assertion below passes
    // vacuously and the guard is untested.
    expect(ACTION_MODULES.length).toBeGreaterThanOrEqual(5);
  });

  for (const specifier of ACTION_MODULES) {
    it(`${specifier} — all exports reject with no session`, async () => {
      forwardedAs(null);
      // @vite-ignore + absolute path: the specifier is computed at runtime,
      // which vite cannot statically analyse through the `@/` alias.
      const mod: Record<string, unknown> = await import(
        /* @vite-ignore */ path.resolve(APP_DIR, "..", specifier)
      );
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

  it("refuses an identity Authelia asserted that is not the allowed one", async () => {
    // Authelia's own access control can be broader than this app wants, so a
    // successfully-authenticated stranger still has to be turned away here.
    forwardedAs({ "remote-email": "someone.else@example.com" });
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).rejects.toThrow(/not signed in/i);
  });

  it("refuses a request carrying no identity header at all", async () => {
    // i.e. something that reached the container without going through Traefik.
    forwardedAs({});
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).rejects.toThrow(/not signed in/i);
  });

  it("admits the configured owner by Remote-Email", async () => {
    forwardedAs({ "remote-email": "owner@example.com" });
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).resolves.toEqual({ user: "owner@example.com" });
  });

  it("admits the configured owner by Remote-User when no email is forwarded", async () => {
    // Not every forward-auth middleware forwards Remote-Email.
    forwardedAs({ "remote-user": "owner@example.com" });
    const { requireSession } = await import("@/lib/auth-guard");
    await expect(requireSession()).resolves.toEqual({ user: "owner@example.com" });
  });
});
