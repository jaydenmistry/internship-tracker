"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import Badge from "@/components/Badge";
import type { ContactDetail } from "@/lib/networking/contacts";
import { CONTACT_STATUS_LABELS, CONTACT_STATUS_TONE, KIND_LABELS } from "@/lib/networking/schema";
import { deleteContactAction, updateContactAction } from "../actions";
import ContactForm from "../ContactForm";
import {
  absoluteDate,
  formFromContact,
  formToPayload,
  linkedinHref,
  mailtoHref,
  relativeAge,
  type ContactForm as Form,
} from "../state";

/**
 * /network/[id] — one contact's details, editable in place, with a hard
 * delete behind a confirmation. Everything shown was typed by the user and is
 * rendered as text.
 */

interface Props {
  contact: ContactDetail;
  companyNames: string[];
  nowIso: string;
}

export default function ContactView({ contact, companyNames, nowIso }: Props) {
  const router = useRouter();
  const nowMs = useMemo(() => Date.parse(nowIso), [nowIso]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pending, startTransition] = useTransition();

  const onSave = () => {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof updateContactAction>>;
      try {
        res = await updateContactAction({ contactId: contact.id, contact: formToPayload(form) });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) setForm(null);
      else setError(res.message);
    });
  };

  const onDelete = () => {
    setError(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof deleteContactAction>>;
      try {
        res = await deleteContactAction({ contactId: contact.id });
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) router.push("/network");
      else {
        setConfirmingDelete(false);
        setError(res.message);
      }
    });
  };

  const li = linkedinHref(contact.linkedinUrl);
  const mail = mailtoHref(contact.email);

  return (
    <div className="flex max-w-5xl flex-col gap-3">
      <nav className="text-[12px] text-dim">
        <Link href="/network" className="hover:text-ink">
          ← Network
        </Link>
      </nav>

      <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1 className="text-[16px] font-medium">{contact.name}</h1>
        {(contact.title || contact.company) && (
          <span className="text-[13px] text-dim">
            {[contact.title, contact.company].filter(Boolean).join(" · ")}
          </span>
        )}
        <span className={`text-[12px] ${CONTACT_STATUS_TONE[contact.status]}`}>
          {CONTACT_STATUS_LABELS[contact.status]}
        </span>
        {contact.doNotContact && (
          <Badge tone="warn" title="No follow-ups are scheduled for this contact">
            do not contact
          </Badge>
        )}
        {!form && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={() => {
                setError(null);
                setConfirmingDelete(false);
                setForm(formFromContact(contact));
              }}
              className="rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink"
            >
              Edit
            </button>
          </div>
        )}
      </header>

      {form ? (
        <section aria-label="Edit contact" className="rounded border border-line bg-panel px-3 py-3">
          <ContactForm
            form={form}
            onChange={setForm}
            onSubmit={onSave}
            onCancel={() => {
              setForm(null);
              setError(null);
            }}
            companyNames={companyNames}
            submitLabel="Save"
            pending={pending}
            error={error}
          />
        </section>
      ) : (
        <section aria-label="Details" className="rounded border border-line bg-panel px-3 py-3">
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            <Fact label="Kind">{KIND_LABELS[contact.kind]}</Fact>
            <Fact label="Company">
              {contact.company ? (
                <>
                  {contact.company}
                  {contact.companyListingCount > 0 && (
                    <span className="ml-2 text-[12px] text-faint">
                      {contact.companyListingCount} listing{contact.companyListingCount === 1 ? "" : "s"} tracked
                    </span>
                  )}
                </>
              ) : null}
            </Fact>
            <Fact label="Email">
              {mail ? (
                <a href={mail} className="font-mono text-accent hover:underline">
                  {contact.email}
                </a>
              ) : (
                contact.email
              )}
            </Fact>
            <Fact label="LinkedIn">
              {li ? (
                <a href={li} target="_blank" rel="noopener noreferrer" className="break-all text-accent hover:underline">
                  {li} ↗
                </a>
              ) : null}
            </Fact>
            <Fact label="How you met">{contact.howMet}</Fact>
            <Fact label="Added">
              <time dateTime={contact.createdAt} title={absoluteDate(contact.createdAt)}>
                {relativeAge(contact.createdAt, nowMs)}
              </time>
            </Fact>
          </dl>
          {contact.notes && (
            <div className="mt-3 border-t border-line-soft pt-3">
              <h2 className="mb-1 font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">Notes</h2>
              <p className="text-[13px] leading-snug whitespace-pre-wrap">{contact.notes}</p>
            </div>
          )}
        </section>
      )}

      {!form && (
        <section aria-label="Danger zone" className="flex flex-wrap items-center gap-2">
          {confirmingDelete ? (
            <>
              <span className="text-[12px] text-bad">
                Delete {contact.name} and every message logged with them? This can&apos;t be undone.
              </span>
              <button
                type="button"
                onClick={onDelete}
                disabled={pending}
                className="rounded border border-bad px-3 py-1 text-[12px] text-bad disabled:opacity-60"
              >
                {pending ? "Deleting…" : "Delete permanently"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmingDelete(false)}
                disabled={pending}
                className="rounded border border-line px-3 py-1 text-[12px] text-dim hover:text-ink"
              >
                Keep
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmingDelete(true)}
              className="rounded border border-line px-3 py-1 text-[12px] text-faint hover:border-bad hover:text-bad"
              title="Mark do-not-contact instead to stop outreach but keep the record"
            >
              Delete contact
            </button>
          )}
          {error && !form && (
            <p role="alert" className="text-[12px] text-bad">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-[12px] text-faint">{label}</dt>
      <dd className="min-w-0">{children ?? <span className="text-faint">—</span>}</dd>
    </>
  );
}
