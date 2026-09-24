"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import Badge from "@/components/Badge";
import Chip from "@/components/Chip";
import type { ContactRow } from "@/lib/networking/contacts";
import {
  CONTACT_KINDS,
  CONTACT_STATUS_LABELS,
  CONTACT_STATUS_TONE,
  CONTACT_STATUSES,
  KIND_LABELS,
} from "@/lib/networking/schema";
import { createContactAction } from "./actions";
import ContactForm from "./ContactForm";
import {
  absoluteDate,
  companiesOf,
  emptyForm,
  filterContacts,
  formToPayload,
  linkedinHref,
  mailtoHref,
  relativeAge,
  toggle,
  type ContactFilters,
  type ContactForm as Form,
} from "./state";

/**
 * /network — every contact, searchable and filterable, plus the Add Contact
 * form. Everything a contact carries was typed by the user, and is still
 * rendered strictly as text; the only hrefs are the re-validated LinkedIn URL
 * and a plain mailto.
 */

interface Props {
  contacts: ContactRow[];
  companyNames: string[];
  /** Open the add form on load, with this company prefilled. */
  initialAdd: { company: string } | null;
  initialQuery: string;
  initialCompanyKey: string | null;
  /** Fixed on the server so first paint and hydration agree on relative dates. */
  nowIso: string;
}

const TH = "px-2 py-1 text-left text-[11px] font-normal text-faint";
const TD = "px-2 py-1 align-top";

export default function NetworkView({
  contacts,
  companyNames,
  initialAdd,
  initialQuery,
  initialCompanyKey,
  nowIso,
}: Props) {
  const router = useRouter();
  const nowMs = useMemo(() => Date.parse(nowIso), [nowIso]);
  const [filters, setFilters] = useState<ContactFilters>({
    query: initialQuery,
    companyKey: initialCompanyKey,
    kinds: new Set(),
    statuses: new Set(),
  });
  const [form, setForm] = useState<Form | null>(initialAdd ? emptyForm(initialAdd.company) : null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const shown = useMemo(() => filterContacts(contacts, filters), [contacts, filters]);
  const companyOptions = useMemo(() => companiesOf(contacts, filters.companyKey), [contacts, filters.companyKey]);

  const onCreate = () => {
    if (!form) return;
    setError(null);
    startTransition(async () => {
      let res: Awaited<ReturnType<typeof createContactAction>>;
      try {
        res = await createContactAction(formToPayload(form));
      } catch (err) {
        res = { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
      if (res.ok) router.push(`/network/${res.id}`);
      else setError(res.message);
    });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-[14px] font-medium">Network</h1>
        <input
          type="search"
          aria-label="Search contacts"
          placeholder="Search name, company, title, email"
          value={filters.query}
          onChange={(e) => setFilters((f) => ({ ...f, query: e.target.value }))}
          className="h-7 w-72 rounded border border-line bg-raised px-2 text-[13px]"
        />
        <select
          aria-label="Filter by company"
          value={filters.companyKey ?? ""}
          onChange={(e) => setFilters((f) => ({ ...f, companyKey: e.target.value || null }))}
          className={`h-7 max-w-[14rem] rounded border bg-raised px-1 text-[13px] ${
            filters.companyKey ? "border-accent text-ink" : "border-line text-dim"
          }`}
        >
          <option value="">any company</option>
          {companyOptions.map((o) => (
            <option key={o.key} value={o.key}>
              {o.name} ({o.count})
            </option>
          ))}
        </select>
        <span className="font-mono text-[11px] text-faint tabular-nums">
          {shown.length === contacts.length ? contacts.length : `${shown.length} / ${contacts.length}`}
        </span>
        {!form && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setForm(emptyForm());
            }}
            className="ml-auto rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink"
          >
            Add contact
          </button>
        )}
      </div>

      {form && (
        <section aria-label="Add contact" className="rounded border border-line bg-panel px-3 py-3">
          <h2 className="mb-2 text-[13px] font-medium">Add contact</h2>
          <ContactForm
            form={form}
            onChange={setForm}
            onSubmit={onCreate}
            onCancel={() => {
              setForm(null);
              setError(null);
            }}
            companyNames={companyNames}
            submitLabel="Add contact"
            pending={pending}
            error={error}
          />
        </section>
      )}

      <div className="flex flex-wrap items-center gap-1" aria-label="Filter by kind">
        <span className="mr-1 text-[11px] text-faint">kind</span>
        {CONTACT_KINDS.map((k) => (
          <Chip
            key={k}
            active={filters.kinds.has(k)}
            onClick={() => setFilters((f) => ({ ...f, kinds: toggle(f.kinds, k) }))}
            count={contacts.filter((c) => c.kind === k).length}
          >
            {KIND_LABELS[k]}
          </Chip>
        ))}
        <span className="mr-1 ml-3 text-[11px] text-faint">status</span>
        {CONTACT_STATUSES.map((s) => (
          <Chip
            key={s}
            active={filters.statuses.has(s)}
            onClick={() => setFilters((f) => ({ ...f, statuses: toggle(f.statuses, s) }))}
            count={contacts.filter((c) => c.status === s).length}
          >
            {CONTACT_STATUS_LABELS[s]}
          </Chip>
        ))}
      </div>

      <div className="rounded border border-line bg-panel">
        <table className="w-full table-fixed border-collapse" data-testid="contacts-table">
          <colgroup>
            <col className="w-[12rem]" />
            <col className="w-[11rem]" />
            <col />
            <col className="w-[7.5rem]" />
            <col className="w-[9rem]" />
            <col className="w-[5rem]" />
            <col className="w-[7rem]" />
          </colgroup>
          <thead className="border-b border-line">
            <tr>
              <th className={TH}>name</th>
              <th className={TH}>company</th>
              <th className={TH}>title</th>
              <th className={TH}>kind</th>
              <th className={TH}>status</th>
              <th className={TH} title="Latest message in either direction">last</th>
              <th className={TH}>reach</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={7} className="px-2 py-6 text-center text-[12px] text-dim">
                  {contacts.length === 0
                    ? "No contacts yet. Add the people you meet at career fairs, through alumni, or on LinkedIn."
                    : "No contacts match these filters."}
                </td>
              </tr>
            )}
            {shown.map((c) => {
              const li = linkedinHref(c.linkedinUrl);
              const mail = mailtoHref(c.email);
              return (
                <tr key={c.id} data-testid="contact-row" className="border-b border-line-soft hover:bg-raised/50">
                  <td className={TD}>
                    <div className="flex min-w-0 items-center gap-1">
                      <Link
                        href={`/network/${c.id}`}
                        className="truncate font-medium text-ink hover:underline decoration-faint underline-offset-2"
                        title={c.name}
                      >
                        {c.name}
                      </Link>
                      {c.doNotContact && (
                        <Badge tone="warn" title="Marked do-not-contact: no follow-ups are scheduled">
                          dnc
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className={`${TD} truncate text-dim`} title={c.company ?? undefined}>
                    {c.company ?? <span className="text-faint">—</span>}
                  </td>
                  <td className={`${TD} truncate text-dim`} title={c.title ?? undefined}>
                    {c.title ?? <span className="text-faint">—</span>}
                  </td>
                  <td className={`${TD} text-[12px] text-dim`}>{KIND_LABELS[c.kind]}</td>
                  <td className={`${TD} text-[12px] ${CONTACT_STATUS_TONE[c.status]}`}>
                    {CONTACT_STATUS_LABELS[c.status]}
                  </td>
                  <td className={`${TD} text-[12px] text-dim`}>
                    <time
                      dateTime={c.lastMessageAt ?? undefined}
                      title={absoluteDate(c.lastMessageAt)}
                      className="font-mono tabular-nums"
                    >
                      {relativeAge(c.lastMessageAt, nowMs)}
                    </time>
                  </td>
                  <td className={`${TD} text-[12px]`}>
                    <div className="flex gap-2">
                      {mail && (
                        <a href={mail} className="text-accent hover:underline" title={c.email ?? undefined}>
                          email
                        </a>
                      )}
                      {li && (
                        <a
                          href={li}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent hover:underline"
                          title={li}
                        >
                          in ↗
                        </a>
                      )}
                      {!mail && !li && <span className="text-faint">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
