"use client";

/**
 * The `?` cheat sheet. Deliberately a plain overlay rather than a dialog: it is
 * read at a glance and dismissed with the same key that opened it.
 */

const GROUPS: Array<{ title: string; keys: Array<[string, string]> }> = [
  {
    title: "Move",
    keys: [
      ["j  ↓", "next row"],
      ["k  ↑", "previous row"],
      ["g", "first row"],
      ["G", "last row"],
      ["Enter", "open the detail panel (follows j/k)"],
      ["o", "open the apply link in a new tab"],
    ],
  },
  {
    title: "Act on the focused row",
    keys: [
      ["a", "applied  (again to undo)"],
      ["s", "save  (toggle)"],
      ["d", "dismiss  (toggle)"],
      ["⇧F10", "row menu  (or right-click a row)"],
    ],
  },
  {
    title: "Find",
    keys: [
      ["/", "focus the search box  (-word excludes a word)"],
      ["Esc", "close menu / panel, leave search"],
      ["?", "show or hide this sheet"],
      ["Ctrl \\", "hide or show the sidebar (⌘\\ on a Mac)"],
    ],
  },
];

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="sheet-in w-full max-w-xl rounded-2xl border border-line bg-panel p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-title font-semibold">Keyboard shortcuts</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-subhead text-faint hover:bg-raised hover:text-ink"
          >
            esc
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-subhead font-medium text-faint">{group.title}</h3>
              <dl className="space-y-1">
                {group.keys.map(([key, label]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <dt className="w-[4.5rem] shrink-0 rounded-md border border-line bg-control px-1 text-center font-mono text-subhead whitespace-nowrap text-ink shadow-[inset_0_-1px_0_var(--line)]">
                      {key}
                    </dt>
                    <dd className="text-callout text-dim">{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-4 border-t border-line-soft pt-2 text-subhead text-faint">
          Single-key shortcuts are ignored while a text field has focus, and never
          fire with ⌘, Ctrl or Alt held.
        </p>
      </div>
    </div>
  );
}
