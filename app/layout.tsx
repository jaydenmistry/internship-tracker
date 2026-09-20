import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { auth } from "@/lib/auth";
import { endSession } from "./signin/actions";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Internship Tracker",
  description: "Ranked internship listings and application tracking.",
};

const NAV = [
  { href: "/", label: "Listings" },
  { href: "/tracker", label: "Tracker" },
  { href: "/import", label: "Import" },
  { href: "/resume", label: "Resume" },
  { href: "/alerts", label: "Alerts" },
] as const;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Only used to decide whether the nav and the sign-out control are worth
  // rendering — proxy.ts and each action's own guard do the actual gating.
  const session = await auth();
  const signedIn = Boolean(session?.user);

  return (
    <html
      lang="en"
      // Dark is the default for this tool, not a toggle. The class strategy is
      // still used so a future preference switch is a one-line change.
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* h-full + min-h-0 on main: the listings table owns its own scroll
          container, so the page itself must not grow past the viewport. */}
      <body className="flex h-full flex-col overflow-hidden bg-canvas text-ink">
        <header className="sticky top-0 z-20 flex h-10 shrink-0 items-center gap-1 border-b border-line bg-panel px-3">
          <span className="mr-3 font-mono text-[11px] font-semibold tracking-wide text-dim uppercase">
            internship-tracker
          </span>
          {/* Signed out, the only reachable page is /signin — linking the rest
              would just bounce off the gate. */}
          {signedIn && (
            <>
              <nav className="flex items-center gap-1">
                {NAV.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="rounded px-2 py-1 text-[12px] text-dim transition-colors hover:bg-raised hover:text-ink"
                  >
                    {item.label}
                  </Link>
                ))}
              </nav>
              <form action={endSession} className="ml-auto flex items-center gap-2">
                <span className="font-mono text-[11px] text-faint">{session?.user?.email}</span>
                <button
                  type="submit"
                  className="rounded px-2 py-1 text-[12px] text-dim transition-colors hover:bg-raised hover:text-ink"
                >
                  Sign out
                </button>
              </form>
            </>
          )}
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
