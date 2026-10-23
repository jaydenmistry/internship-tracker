"use client";

import { useEffect, useState } from "react";

/**
 * The one toast. Confirmations fade on their own, celebrations linger long
 * enough to read (and to hit Undo), errors stay until dismissed. Hovering
 * holds it open.
 */
export interface ToastData {
  /** Changes per toast, so a new one restarts the entrance and the timer. */
  id: number;
  kind: "ok" | "error" | "celebrate";
  message: string;
  action?: { label: string; run: () => void };
}

const LINGER_MS: Record<ToastData["kind"], number | null> = {
  ok: 2200,
  celebrate: 5500,
  error: null,
};

export default function Toast({ toast, onClose }: { toast: ToastData; onClose: () => void }) {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    const ms = LINGER_MS[toast.kind];
    if (ms === null || held) return;
    const id = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.kind, held, onClose]);

  const tone =
    toast.kind === "error"
      ? "border-bad/60 text-bad"
      : toast.kind === "celebrate"
        ? "toast-celebrate border-transparent text-ink"
        : "border-ok/50 text-ok";

  return (
    <div
      key={toast.id}
      role={toast.kind === "error" ? "alert" : "status"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      className={`toast-in fixed bottom-5 left-1/2 z-[60] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border bg-panel px-4 py-2.5 text-body shadow-lg sm:max-w-lg ${tone}`}
    >
      <span className="min-w-0 flex-1">{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            toast.action?.run();
            onClose();
          }}
          className="shrink-0 rounded-md px-2 py-0.5 font-semibold text-accent hover:bg-accent/10"
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        onClick={onClose}
        className="shrink-0 text-faint hover:text-ink"
        aria-label="Dismiss message"
      >
        ×
      </button>
    </div>
  );
}
