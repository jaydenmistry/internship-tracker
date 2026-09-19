import type { Metadata } from "next";
import Link from "next/link";
import { Geist, Geist_Mono } from "next/font/google";
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
  { href: "/import", label: "Import" },
] as const;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      // Dark is the default for this tool, not a toggle. The class strategy is
      // still used so a future preference switch is a one-line change.
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col bg-canvas text-ink">
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
        </header>
        <main className="flex flex-1 flex-col">{children}</main>
      </body>
    </html>
  );
}
