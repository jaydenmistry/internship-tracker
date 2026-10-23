"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  Bell,
  FileText,
  Import,
  ListOrdered,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  PenLine,
  SlidersHorizontal,
  SquareKanban,
  Sun,
  Users,
  Volume2,
  VolumeX,
  type LucideIcon,
} from "lucide-react";
import { applyTheme, SIDEBAR_COOKIE, writePreference, type Theme } from "./preferences";
import { attrSelector, NAV_BUMP_EVENT, prefersReducedMotion } from "./celebrate";
import { isSoundOn, onSoundChange, setSoundOn } from "./celebrate/sound";

/**
 * App navigation: a sidebar from 768px up (sidebars.md — two levels at most,
 * and it can be hidden), a scrolling row of sections below it. Hiding the
 * sidebar collapses it to an icon rail (⌘\ or Ctrl+\), so every section is
 * still one click away and the toggle never disappears. The current section
 * is marked with aria-current as well as style, including on nested pages
 * like /network/[id], which highlight their section.
 */

interface Item {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shown in the compact row too; settings pages live in the sidebar only. */
  compact?: true;
}

const GROUPS: ReadonlyArray<{ label: string | null; items: readonly Item[] }> = [
  {
    label: null,
    items: [
      { href: "/", label: "Listings", icon: ListOrdered, compact: true },
      { href: "/tracker", label: "Tracker", icon: SquareKanban, compact: true },
      { href: "/network", label: "Network", icon: Users, compact: true },
    ],
  },
  {
    label: "Add",
    items: [
      { href: "/import", label: "Import applications", icon: Import, compact: true },
      { href: "/resume", label: "Resume", icon: FileText, compact: true },
    ],
  },
  {
    label: "Settings",
    items: [
      { href: "/alerts", label: "Alerts", icon: Bell, compact: true },
      { href: "/cover-letter/settings", label: "Letterhead", icon: PenLine },
      { href: "/network/settings", label: "Follow-up rules", icon: SlidersHorizontal },
    ],
  },
];

const ALL = GROUPS.flatMap((g) => g.items);

/** The most specific item whose path is a prefix of the current one. */
function currentHref(pathname: string): string | null {
  let best: string | null = null;
  for (const item of ALL) {
    const hit =
      item.href === "/"
        ? pathname === "/" || (pathname.startsWith("/cover-letter") && !pathname.startsWith("/cover-letter/settings"))
        : pathname === item.href || pathname.startsWith(`${item.href}/`);
    if (hit && (best === null || item.href.length > best.length)) best = item.href;
  }
  return best;
}

/** The theme on <html>, kept in sync wherever it was switched from. */
function useTheme(initial: Theme): Theme {
  return useSyncExternalStore(
    (onChange) => {
      const observer = new MutationObserver(onChange);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      return () => observer.disconnect();
    },
    () => (document.documentElement.dataset.theme === "light" ? "light" : "dark"),
    () => initial,
  );
}

function ThemeButton({ theme, className }: { theme: Theme; className: string }) {
  const next: Theme = theme === "dark" ? "light" : "dark";
  const label = `Switch to ${next} mode`;
  return (
    <button type="button" onClick={() => applyTheme(next)} title={label} aria-label={label} className={className}>
      {theme === "dark" ? <Sun aria-hidden size={15} /> : <Moon aria-hidden size={15} />}
    </button>
  );
}

/** Celebration sounds on or off; on by default. */
function SoundButton({ className }: { className: string }) {
  const on = useSyncExternalStore(onSoundChange, isSoundOn, () => true);
  const label = on ? "Mute celebration sounds" : "Turn on celebration sounds";
  return (
    <button
      type="button"
      onClick={() => setSoundOn(!on)}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className={className}
    >
      {on ? <Volume2 aria-hidden size={15} /> : <VolumeX aria-hidden size={15} />}
    </button>
  );
}

/**
 * A celebration elsewhere bumps the matching nav item: its icon hops and a
 * "+1" floats off it, so you see the application land in the Tracker.
 */
function useNavBump(): void {
  useEffect(() => {
    const onBump = (e: Event) => {
      const href = (e as CustomEvent<string>).detail;
      if (prefersReducedMotion()) return;
      for (const link of document.querySelectorAll<HTMLElement>(attrSelector("data-nav-href", href))) {
        if (!link.offsetParent) continue;
        const icon = link.querySelector("svg") ?? link;
        icon.animate(
          [
            { transform: "none" },
            { transform: "translateY(-5px) rotate(-14deg) scale(1.3)", offset: 0.35 },
            { transform: "translateY(1px) rotate(6deg) scale(0.95)", offset: 0.7 },
            { transform: "none" },
          ],
          { duration: 650, easing: "cubic-bezier(0.34, 1.36, 0.64, 1)" },
        );
        const plus = document.createElement("span");
        plus.textContent = "+1";
        plus.setAttribute("aria-hidden", "true");
        plus.className = "pointer-events-none absolute right-2 top-0 text-footnote font-bold text-ok";
        if (getComputedStyle(link).position === "static") link.style.position = "relative";
        link.appendChild(plus);
        const anim = plus.animate(
          [
            { opacity: 0, transform: "translateY(6px) scale(0.6)" },
            { opacity: 1, transform: "translateY(-4px) scale(1.15)", offset: 0.3 },
            { opacity: 0, transform: "translateY(-18px) scale(1)" },
          ],
          { duration: 1100, easing: "ease-out" },
        );
        anim.onfinish = anim.oncancel = () => plus.remove();
      }
    };
    window.addEventListener(NAV_BUMP_EVENT, onBump);
    return () => window.removeEventListener(NAV_BUMP_EVENT, onBump);
  }, []);
}

const ICON_BUTTON =
  "flex size-7 shrink-0 items-center justify-center rounded-md text-faint transition-colors hover:bg-raised hover:text-ink";

interface Props {
  identity: string | null;
  logoutUrl: string | null;
  initialCollapsed: boolean;
  initialTheme: Theme;
}

export function Sidebar({ identity, logoutUrl, initialCollapsed, initialTheme }: Props) {
  const current = currentHref(usePathname() ?? "/");
  const theme = useTheme(initialTheme);
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  useNavBump();

  const toggle = () =>
    setCollapsed((c) => {
      writePreference(SIDEBAR_COOKIE, c ? "shown" : "collapsed");
      return !c;
    });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === "\\") {
        e.preventDefault();
        setCollapsed((c) => {
          writePreference(SIDEBAR_COOKIE, c ? "shown" : "collapsed");
          return !c;
        });
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const toggleLabel = collapsed ? "Show sidebar (Ctrl+\\)" : "Hide sidebar (Ctrl+\\)";

  return (
    <aside
      data-collapsed={collapsed ? "" : undefined}
      className={`hidden shrink-0 flex-col overflow-hidden border-r border-line bg-sidebar transition-[width] duration-300 ease-[var(--ease-out)] md:flex ${
        collapsed ? "w-[3.75rem]" : "w-60"
      }`}
    >
      <div className={`flex h-14 shrink-0 items-center gap-2.5 ${collapsed ? "justify-center px-0" : "px-4"}`}>
        {!collapsed && (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element -- the app's own icon, shown at 22px */}
            <img src="/icon.png" alt="" width={22} height={22} className="size-[22px] rounded-[6px]" />
            <span className="min-w-0 flex-1 truncate text-body font-semibold tracking-tight">Internship Tracker</span>
          </>
        )}
        <button type="button" onClick={toggle} title={toggleLabel} aria-label={toggleLabel} aria-expanded={!collapsed} className={ICON_BUTTON}>
          {collapsed ? <PanelLeftOpen aria-hidden size={16} /> : <PanelLeftClose aria-hidden size={16} />}
        </button>
      </div>

      <nav aria-label="Sections" className="flex min-h-0 flex-1 flex-col gap-5 overflow-x-hidden overflow-y-auto px-2.5 pt-1 pb-3">
        {GROUPS.map((group, i) => (
          <div key={group.label ?? i} className="flex flex-col gap-0.5">
            {group.label &&
              (collapsed ? (
                <div aria-hidden className="mx-2 mb-1 border-t border-line" />
              ) : (
                <p className="px-2.5 pb-1 text-footnote font-semibold tracking-[0.06em] text-faint uppercase">{group.label}</p>
              ))}
            {group.items.map((item) => {
              const on = item.href === current;
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  data-nav-href={item.href}
                  aria-current={on ? "page" : undefined}
                  aria-label={collapsed ? item.label : undefined}
                  title={collapsed ? item.label : undefined}
                  className={`group flex h-8 items-center gap-3 rounded-lg text-body transition-colors ${
                    collapsed ? "justify-center px-0" : "px-2.5"
                  } ${on ? "bg-raised font-medium text-ink shadow-[inset_0_1px_0_var(--highlight)]" : "text-dim hover:bg-raised/60 hover:text-ink"}`}
                >
                  <Icon
                    aria-hidden
                    size={16}
                    strokeWidth={on ? 2.2 : 1.8}
                    className={`shrink-0 transition-colors ${on ? "text-accent" : "text-faint group-hover:text-dim"}`}
                  />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div
        className={`flex shrink-0 gap-1 border-t border-line py-3 ${
          collapsed ? "flex-col items-center px-0" : "items-center px-4"
        }`}
      >
        {!collapsed && identity && <span className="min-w-0 flex-1 truncate text-subhead text-faint">{identity}</span>}
        <SoundButton className={ICON_BUTTON} />
        <ThemeButton theme={theme} className={ICON_BUTTON} />
        {/* Authelia owns the session, so signing out is its business; the
            link is omitted when AUTH_LOGOUT_URL is unset rather than dead. */}
        {logoutUrl && (
          <a href={logoutUrl} title="Sign out" aria-label="Sign out" className={ICON_BUTTON}>
            <LogOut aria-hidden size={15} />
          </a>
        )}
      </div>
    </aside>
  );
}

export function CompactNav({ initialTheme }: { initialTheme: Theme }) {
  const current = currentHref(usePathname() ?? "/");
  const theme = useTheme(initialTheme);
  useNavBump();
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 border-b border-line bg-sidebar pr-2 md:hidden">
      <nav aria-label="Sections" className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2">
        {ALL.filter((item) => item.compact).map((item) => {
          const on = item.href === current;
          return (
            <Link
              key={item.href}
              href={item.href}
              data-nav-href={item.href}
              aria-current={on ? "page" : undefined}
              className={`flex h-8 shrink-0 items-center rounded-lg px-3 text-callout transition-colors ${
                on ? "bg-raised font-medium text-ink" : "text-dim hover:bg-raised hover:text-ink"
              }`}
            >
              {item.label === "Import applications" ? "Import" : item.label}
            </Link>
          );
        })}
      </nav>
      <SoundButton className={ICON_BUTTON} />
      <ThemeButton theme={theme} className={ICON_BUTTON} />
    </header>
  );
}
