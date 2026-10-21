import type { ReactNode } from "react";

/**
 * The title block every page opens with: a Title 1 heading, an optional one-
 * or two-sentence description, and the page's own actions on the trailing
 * side (layout.md — most important content at the top and leading edge).
 */
interface Props {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small text before the title, e.g. a back link. */
  eyebrow?: ReactNode;
}

export default function PageHeader({ title, description, actions, eyebrow }: Props) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-callout text-faint">{eyebrow}</div>}
        <h1 className="text-headline leading-tight font-bold tracking-[-0.025em]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-body leading-relaxed text-dim">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
