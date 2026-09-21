import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { identityFromHeaders } from "@/lib/auth";
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
  // Display only. proxy.ts and each action's own guard do the actual gating;
  // by the time this renders, the request has already been through both.
  const identity = identityFromHeaders(await headers());

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
          {/* Authelia owns the session, so signing out is its business, not
              this app's — there is nothing here to sign out OF. The link goes
              to whatever AUTH_LOGOUT_URL names, and is simply omitted when
              that is unset rather than rendering a dead control. */}
          <div className="ml-auto flex items-center gap-2">
            {identity && <span className="font-mono text-[11px] text-faint">{identity}</span>}
            {process.env.AUTH_LOGOUT_URL && (
              <a
                href={process.env.AUTH_LOGOUT_URL}
                className="rounded px-2 py-1 text-[12px] text-dim transition-colors hover:bg-raised hover:text-ink"
              >
                Sign out
              </a>
            )}
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
      </body>
    </html>
  );
}
