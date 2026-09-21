import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { startSignIn } from "./actions";

export const dynamic = "force-dynamic";

/**
 * The only page reachable without a session.
 *
 * It does two jobs: offer the single sign-in button, and — when the server is
 * misconfigured — say exactly which variable is missing. Auth.js's own error
 * page reports "Configuration" and nothing else, which is a miserable thing to
 * debug on a fresh deploy.
 */

/** Which required variables are unset. Names only — never values. */
function missingConfig(): string[] {
  const required = [
    "AUTH_SECRET",
    "AUTH_OIDC_ISSUER",
    "AUTH_OIDC_ID",
    "AUTH_OIDC_SECRET",
    "ALLOWED_EMAIL",
  ];
  return required.filter((name) => (process.env[name] ?? "").trim() === "");
}

const ERRORS: Record<string, string> = {
  AccessDenied:
    "That account is not the one this tracker is configured for. Only the address in ALLOWED_EMAIL can sign in.",
  Configuration:
    "The server rejected the sign-in configuration. Check the OIDC client ID, secret and issuer.",
  Verification: "That sign-in link is no longer valid. Try again.",
};

export default async function SignInPage({ searchParams }: PageProps<"/signin">) {
  // Already signed in: the page has nothing to offer.
  if (await auth()) redirect("/");

  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const next = one(params.next) ?? "/";
  const error = one(params.error);
  const missing = missingConfig();

  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-md rounded border border-line bg-panel p-6">
        <h1 className="text-[15px] font-semibold text-ink">Internship Tracker</h1>
        <p className="mt-1 text-[12px] text-dim">
          This tracker is for one account. Sign in with Authelia to continue.
        </p>

        {error && (
          <p
            data-testid="signin-error"
            className="mt-4 rounded border border-bad/40 bg-bad/10 p-3 text-[12px] text-bad"
          >
            {ERRORS[error] ?? "Sign-in failed. Try again."}
          </p>
        )}

        {missing.length > 0 ? (
          <div
            data-testid="signin-misconfigured"
            className="mt-4 rounded border border-bad/40 bg-bad/10 p-3 text-[12px] text-bad"
          >
            <p className="font-semibold">Sign-in is not configured on this server.</p>
            <p className="mt-1">
              These environment variables are unset, so no one can sign in:
            </p>
            <ul className="mt-2 font-mono text-[11px]">
              {missing.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </div>
        ) : (
          <form action={startSignIn} className="mt-5">
            <input type="hidden" name="next" value={next} />
            <button
              type="submit"
              className="w-full rounded bg-accent px-3 py-2 text-[13px] font-medium text-canvas transition-opacity hover:opacity-90"
            >
              Sign in with Authelia
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
