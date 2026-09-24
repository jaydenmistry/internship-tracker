"use client";

import { useId } from "react";
import { CONTACT_KINDS, CONTACT_LIMITS, KIND_LABELS } from "@/lib/networking/schema";
import type { ContactKind } from "@/generated/prisma/enums";
import type { ContactForm as Form } from "./state";

/**
 * The add/edit form. Company comes FIRST and autocompletes against every
 * company the app knows: the normalizer folds "Stripe, Inc." into "Stripe",
 * but it cannot know that "Facebook" is "Meta", so picking the existing name
 * is what keeps a person attached to that company's listings.
 */

interface Props {
  form: Form;
  onChange: (next: Form) => void;
  onSubmit: () => void;
  onCancel?: () => void;
  companyNames: readonly string[];
  submitLabel: string;
  pending: boolean;
  error: string | null;
}

const INPUT = "h-7 w-full rounded border border-line bg-raised px-2 text-[13px]";
const LABEL = "flex min-w-0 flex-col gap-1";
const CAPTION = "text-[12px] text-dim";

export default function ContactForm({
  form,
  onChange,
  onSubmit,
  onCancel,
  companyNames,
  submitLabel,
  pending,
  error,
}: Props) {
  const listId = useId();
  const set = <K extends keyof Form>(key: K, value: Form[K]) => onChange({ ...form, [key]: value });

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-x-4 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className={LABEL}>
          <span className={CAPTION}>Company</span>
          <input
            list={listId}
            value={form.company}
            maxLength={CONTACT_LIMITS.company}
            onChange={(e) => set("company", e.target.value)}
            placeholder="Start typing to pick an existing one"
            className={INPUT}
            autoFocus
          />
          <datalist id={listId}>
            {companyNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>
            Name <span className="text-bad">*</span>
          </span>
          <input
            required
            value={form.name}
            maxLength={CONTACT_LIMITS.name}
            onChange={(e) => set("name", e.target.value)}
            className={INPUT}
          />
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Title</span>
          <input
            value={form.title}
            maxLength={CONTACT_LIMITS.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Senior SWE, University Recruiter…"
            className={INPUT}
          />
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Kind</span>
          <select
            value={form.kind}
            onChange={(e) => set("kind", e.target.value as ContactKind)}
            className={INPUT}
          >
            {CONTACT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>Email</span>
          <input
            type="email"
            value={form.email}
            maxLength={CONTACT_LIMITS.email}
            onChange={(e) => set("email", e.target.value)}
            className={`${INPUT} font-mono`}
          />
        </label>
        <label className={LABEL}>
          <span className={CAPTION}>LinkedIn URL</span>
          <input
            type="url"
            value={form.linkedinUrl}
            maxLength={CONTACT_LIMITS.linkedinUrl}
            onChange={(e) => set("linkedinUrl", e.target.value)}
            placeholder="https://www.linkedin.com/in/…"
            className={`${INPUT} font-mono`}
          />
        </label>
        <label className={`${LABEL} sm:col-span-2 lg:col-span-3`}>
          <span className={CAPTION}>How you met</span>
          <input
            value={form.howMet}
            maxLength={CONTACT_LIMITS.howMet}
            onChange={(e) => set("howMet", e.target.value)}
            placeholder="UGA career fair 9/2026, alumni directory, cold on LinkedIn…"
            className={INPUT}
          />
        </label>
        <label className={`${LABEL} sm:col-span-2 lg:col-span-3`}>
          <span className={CAPTION}>Notes</span>
          <textarea
            value={form.notes}
            maxLength={CONTACT_LIMITS.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={4}
            placeholder="What you talked about, what they work on, anything a draft should mention."
            className="w-full rounded border border-line bg-raised px-2 py-1 text-[13px] leading-snug"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={form.doNotContact}
          onChange={(e) => set("doNotContact", e.target.checked)}
        />
        Do not contact
        <span className="text-[12px] text-faint">keeps the record, never schedules a follow-up</span>
      </label>

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink disabled:opacity-60"
        >
          {pending ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            disabled={pending}
            className="rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink"
          >
            Cancel
          </button>
        )}
        {error && (
          <p role="alert" className="text-[12px] text-bad">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
