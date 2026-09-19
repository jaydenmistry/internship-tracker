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
      ["Enter", "open the detail panel"],
      ["o", "open the apply link in a new tab"],
    ],
  },
  {
    title: "Act on the focused row",
    keys: [
      ["a", "applied  (again to undo)"],
      ["s", "save  (toggle)"],
      ["d", "dismiss  (toggle)"],
    ],
  },
  {
    title: "Find",
    keys: [
      ["/", "focus the search box"],
      ["Esc", "leave search, clear the cursor"],
      ["?", "show or hide this sheet"],
    ],
  },
];

export default function HelpOverlay({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-xl rounded-md border border-line bg-panel p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="font-mono text-[11px] font-semibold tracking-wide text-dim uppercase">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-1.5 py-0.5 text-[11px] text-faint hover:bg-raised hover:text-ink"
          >
            esc
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {GROUPS.map((group) => (
            <section key={group.title}>
              <h3 className="mb-1.5 text-[11px] font-medium text-faint">{group.title}</h3>
              <dl className="space-y-1">
                {group.keys.map(([key, label]) => (
                  <div key={key} className="flex items-baseline gap-2">
                    <dt className="w-[4.5rem] shrink-0 rounded-sm border border-line bg-raised px-1 text-center font-mono text-[11px] whitespace-nowrap text-ink">
                      {key}
                    </dt>
                    <dd className="text-[12px] text-dim">{label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="mt-4 border-t border-line-soft pt-2 text-[11px] text-faint">
          Shortcuts are ignored while a text field has focus, and never fire with
          ⌘, Ctrl or Alt held.
        </p>
      </div>
    </div>
  );
}
