"use client";

import { useState, useTransition } from "react";
import type { SavedView } from "@/lib/listings/views";
import { deleteViewAction, saveViewAction, setDefaultViewAction } from "./actions";
import FilterMenu, { PanelHeader } from "./FilterMenu";

/**
 * Saved views: a named filters-and-sort combination, one click to reapply.
 * Stored server-side so they follow the user across devices; the one marked
 * as default opens whenever `/` is visited without a query of its own.
 */
interface Props {
  views: SavedView[];
  /** The table's current query, as `viewToQuery` writes it. */
  currentQuery: string;
  onApply: (query: string) => void;
  onChange: (views: SavedView[]) => void;
}

type Result = Awaited<ReturnType<typeof saveViewAction>>;

export default function ViewsMenu({ views, currentQuery, onApply, onChange }: Props) {
  const [name, setName] = useState("");
  const [asDefault, setAsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const current = views.find((v) => v.query === currentQuery) ?? null;

  const run = (action: () => Promise<Result>, done?: () => void) => {
    setError(null);
    startTransition(async () => {
      let result: Result;
      try {
        result = await action();
      } catch (err) {
        result = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (result.ok) {
        onChange(result.views);
        done?.();
      } else {
        setError(result.message);
      }
    });
  };

  const save = () =>
    run(
      () => saveViewAction({ name, query: currentQuery, isDefault: asDefault }),
      () => {
        setName("");
        setAsDefault(false);
      },
    );

  return (
    <FilterMenu
      label="Views"
      summary={current?.name ?? null}
      active={false}
      align="right"
      widthClass="w-72"
      title="Save and reuse filter + sort combinations"
    >
      {(close) => (
        <div>
          <PanelHeader hint="Saved views" />
          {views.length === 0 ? (
            <p className="px-1 py-1 text-faint">
              None yet. Set up filters and a sort, then save them here.
            </p>
          ) : (
            <ul className="max-h-64 overflow-y-auto">
              {views.map((view) => (
                <li key={view.id} className="group flex items-center gap-1 rounded hover:bg-raised">
                  <button
                    type="button"
                    onClick={() => {
                      onApply(view.query);
                      close();
                    }}
                    className={`min-w-0 flex-1 truncate px-1 py-[3px] text-left ${
                      view.id === current?.id ? "text-ink" : "text-dim hover:text-ink"
                    }`}
                    title={view.query ? `?${view.query}` : "No filters, default sort"}
                  >
                    {view.name}
                    {view.isDefault && <span className="ml-1.5 text-footnote text-accent">default</span>}
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => setDefaultViewAction({ id: view.isDefault ? null : view.id }))}
                    title={view.isDefault ? "Stop opening this view by default" : "Open this view by default"}
                    aria-label={view.isDefault ? `Unset ${view.name} as default` : `Make ${view.name} the default`}
                    className={`rounded px-1 ${view.isDefault ? "text-accent" : "text-faint opacity-0 group-hover:opacity-100 focus:opacity-100"} hover:text-ink`}
                  >
                    ★
                  </button>
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => run(() => deleteViewAction({ id: view.id }))}
                    aria-label={`Delete view ${view.name}`}
                    title="Delete this view"
                    className="rounded px-1 text-faint opacity-0 group-hover:opacity-100 hover:text-bad focus:opacity-100"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            className="mt-2 border-t border-line-soft pt-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <label className="block px-1 text-subhead text-faint">
              Save the current filters and sort as
              <input
                type="text"
                value={name}
                maxLength={60}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Summer 2027 backend"
                className="mt-1 w-full rounded-md border border-line bg-canvas px-1.5 py-[3px] text-callout text-ink placeholder:text-faint focus:border-accent focus:outline-none"
              />
            </label>
            <label className="mt-1.5 flex cursor-pointer items-center gap-2 px-1 text-dim">
              <input
                type="checkbox"
                checked={asDefault}
                onChange={(e) => setAsDefault(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Open this view by default
            </label>
            <p className="mt-1 px-1 text-subhead text-faint">Saving under an existing name updates it.</p>
            <button
              type="submit"
              disabled={pending || name.trim() === ""}
              className="mt-1.5 w-full rounded border border-line px-2 py-1 text-dim hover:border-faint hover:text-ink disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save view"}
            </button>
            {error && (
              <p role="alert" className="mt-1.5 px-1 text-subhead text-bad">
                {error}
              </p>
            )}
          </form>
        </div>
      )}
    </FilterMenu>
  );
}
