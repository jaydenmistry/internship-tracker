/**
 * Re-mounted on every navigation (unlike the layout), so each page arrives
 * with a short fade-and-rise. The wrapper keeps the flex column the
 * listings table needs to own its scrolling.
 */
export default function Template({ children }: { children: React.ReactNode }) {
  return <div className="page-in flex min-h-0 flex-1 flex-col">{children}</div>;
}
