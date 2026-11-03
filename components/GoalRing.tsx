"use client";

import { Target } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { setWeeklyGoalAction } from "@/app/tracker/actions";
import type { WeekProgress } from "@/lib/applications/progress";
import { prefersReducedMotion, WEEK_EVENT } from "./celebrate";

/**
 * The weekly goal: a ring that fills as you apply this week (Monday start).
 * Click it to change the goal or turn it off. The count comes from the
 * layout on every navigation, and from each status change in between (the
 * celebrations announce it), so it moves the moment you apply.
 */
type Placement = "above" | "right" | "below";

interface Props {
  initial: WeekProgress | null;
  /** The icon rail and the phone bar show the ring alone. */
  compact?: boolean;
  /** Where the goal editor opens: the sidebar clips overflow, so it is fixed to the viewport. */
  placement?: Placement;
}

const SIZE = 30;
const STROKE = 3.5;
const R = (SIZE - STROKE) / 2;
const C = 2 * Math.PI * R;

export default function GoalRing({ initial, compact = false, placement = "above" }: Props) {
  const [progress, setProgress] = useState<WeekProgress | null>(initial);
  // The root layout re-renders on refresh() (every tracker status change, the
  // goal action) and on a full load, not on soft navigation: adopt its numbers
  // when they change. Between those, WEEK_EVENT carries the count.
  const [seen, setSeen] = useState(initial);
  if (initial !== seen && (initial?.week !== seen?.week || initial?.goal !== seen?.goal)) {
    setSeen(initial);
    setProgress(initial);
  }

  const [open, setOpen] = useState<DOMRect | null>(null);
  const ringRef = useRef<SVGSVGElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  // The count on screen, for the hop: read outside a state updater, which
  // StrictMode runs twice.
  const weekRef = useRef(initial?.week ?? 0);
  useEffect(() => {
    weekRef.current = progress?.week ?? 0;
  }, [progress]);

  useEffect(() => {
    const onWeek = (e: Event) => {
      const next = (e as CustomEvent<WeekProgress>).detail;
      if (next.week > weekRef.current && !prefersReducedMotion()) {
        ringRef.current?.animate(
          [{ transform: "scale(1)" }, { transform: "scale(1.25)", offset: 0.35 }, { transform: "scale(1)" }],
          { duration: 600, easing: "cubic-bezier(0.34, 1.36, 0.64, 1)" },
        );
      }
      weekRef.current = next.week;
      setProgress(next);
    };
    window.addEventListener(WEEK_EVENT, onWeek);
    return () => window.removeEventListener(WEEK_EVENT, onWeek);
  }, []);

  // Close the editor on an outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(null);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!progress) return null;
  const { week, goal } = progress;
  const done = goal !== null && week >= goal;
  const fraction = goal ? Math.min(1, week / goal) : 0;
  const label = goal ? `Weekly goal: ${week} of ${goal} applications this week${done ? " — done!" : ""}` : `${week} applications this week (no weekly goal)`;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={(e) => setOpen(open ? null : e.currentTarget.getBoundingClientRect())}
        aria-expanded={open !== null}
        aria-haspopup="dialog"
        title={`${label}. Click to change.`}
        aria-label={`${label}. Change goal`}
        className={`flex items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-raised/60 ${
          compact ? "p-1" : "w-full px-2 py-1.5"
        }`}
      >
        <svg
          ref={ringRef}
          data-goal-ring=""
          width={SIZE}
          height={SIZE}
          viewBox={`0 0 ${SIZE} ${SIZE}`}
          aria-hidden
          className="shrink-0 -rotate-90"
        >
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="var(--raised)" strokeWidth={STROKE} />
          {goal !== null && (
            <circle
              cx={SIZE / 2}
              cy={SIZE / 2}
              r={R}
              fill="none"
              stroke={done ? "var(--ok)" : "var(--accent)"}
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - fraction)}
              className="transition-[stroke-dashoffset,stroke] duration-700 ease-[var(--ease-out)]"
            />
          )}
          <text
            x="50%"
            y="50%"
            dominantBaseline="central"
            textAnchor="middle"
            transform={`rotate(90 ${SIZE / 2} ${SIZE / 2})`}
            className="fill-ink text-[10px] font-semibold tabular-nums"
          >
            {done ? "✓" : week}
          </text>
        </svg>
        {!compact && (
          <span className="min-w-0 leading-tight">
            <span className="block truncate text-callout font-medium text-ink">
              {goal ? (done ? "Goal met! 🎯" : `${week} of ${goal} this week`) : `${week} this week`}
            </span>
            <span className="block truncate text-footnote text-faint">
              {goal ? (done ? `${week} sent this week` : `${goal - week} to go`) : "Set a weekly goal"}
            </span>
          </span>
        )}
      </button>
      {open && (
        <GoalEditor
          goal={goal}
          anchor={open}
          placement={placement}
          onSaved={(g) => setProgress({ week, goal: g })}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

function editorPosition(anchor: DOMRect, placement: Placement): React.CSSProperties {
  const gap = 8;
  switch (placement) {
    case "right":
      return { left: anchor.right + gap, bottom: Math.max(gap, window.innerHeight - anchor.bottom) };
    case "below":
      return { top: anchor.bottom + gap, right: Math.max(gap, window.innerWidth - anchor.right) };
    default:
      return { left: Math.max(gap, anchor.left), bottom: window.innerHeight - anchor.top + gap };
  }
}

function GoalEditor({
  goal,
  anchor,
  placement,
  onSaved,
  onClose,
}: {
  goal: number | null;
  anchor: DOMRect;
  placement: Placement;
  onSaved: (goal: number | null) => void;
  onClose: () => void;
}) {
  const id = useId();
  const [value, setValue] = useState(String(goal ?? 10));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save(next: number | null) {
    setSaving(true);
    setError(null);
    try {
      const res = await setWeeklyGoalAction({ goal: next });
      if (!res.ok) setError(res.message);
      else {
        onSaved(next);
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  const n = Number(value);
  const valid = Number.isInteger(n) && n >= 1 && n <= 100;

  return (
    <div
      role="dialog"
      aria-label="Weekly goal"
      style={editorPosition(anchor, placement)}
      className="fixed z-[70] w-60 rounded-xl border border-line bg-panel p-3 shadow-lg"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) void save(n);
        }}
        className="flex flex-col gap-2"
      >
        <label htmlFor={id} className="flex items-center gap-1.5 text-callout font-medium text-ink">
          <Target aria-hidden size={14} className="text-accent" />
          Applications per week
        </label>
        <div className="flex gap-2">
          <input
            id={id}
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            className="h-8 w-20 rounded-md border border-line bg-control px-2 text-body text-ink tabular-nums"
          />
          <button
            type="submit"
            disabled={!valid || saving}
            className="h-8 flex-1 rounded-md bg-accent-fill px-3 text-callout font-medium text-accent-ink disabled:opacity-50"
          >
            Save
          </button>
        </div>
        <p className="text-footnote text-faint">Weeks start Monday. Meeting it earns a celebration.</p>
        {goal !== null && (
          <button
            type="button"
            disabled={saving}
            onClick={() => void save(null)}
            className="self-start text-footnote text-dim hover:text-ink hover:underline"
          >
            Turn off the goal
          </button>
        )}
        {error && (
          <p role="alert" className="text-footnote text-bad">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
