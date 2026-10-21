import type { Metadata } from "next";
import { Geist_Mono, Inter } from "next/font/google";
import { cookies, headers } from "next/headers";
import { identityFromHeaders } from "@/lib/auth";
import { CompactNav, Sidebar } from "@/components/NavLinks";
import { SIDEBAR_COOKIE, THEME_COOKIE, type Theme } from "@/components/preferences";
import "./globals.css";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  axes: ["opsz"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Internship Tracker",
  description: "Ranked internship listings and application tracking.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Display only. proxy.ts and each action's own guard do the actual gating;
  // by the time this renders, the request has already been through both.
  const identity = identityFromHeaders(await headers());
  // Display preferences live in cookies, not localStorage, so the server
  // renders the chosen theme and sidebar on the first byte — no flash.
  const jar = await cookies();
  const theme: Theme = jar.get(THEME_COOKIE)?.value === "light" ? "light" : "dark";
  const sidebarCollapsed = jar.get(SIDEBAR_COOKIE)?.value === "collapsed";

  return (
    <html
      lang="en"
      data-theme={theme}
      className={`${inter.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* h-full + min-h-0 on main: the listings table owns its own scroll
          container, so the page itself must not grow past the viewport. */}
      <body className="flex h-full overflow-hidden bg-canvas text-ink">
        <Sidebar
          identity={identity}
          logoutUrl={process.env.AUTH_LOGOUT_URL || null}
          initialCollapsed={sidebarCollapsed}
          initialTheme={theme}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <CompactNav initialTheme={theme} />
          <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
