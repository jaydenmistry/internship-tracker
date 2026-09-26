"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";
import Badge from "@/components/Badge";
import Chip from "@/components/Chip";
import type { ContactRow } from "@/lib/networking/contacts";
import type { DueFollowUp } from "@/lib/networking/followups";
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
  DUE_LABELS,
  dueWhen,
  emptyForm,
  filterContacts,
  SORT_LABELS,
  sortContacts,
  type ContactSort,
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
  /** Due today or overdue, oldest first (dates as ISO strings). */
  due: Array<Omit<DueFollowUp, "dueAt"> & { dueAt: string }>;
  /** The server's follow-up zone — due days render in it. */
  timeZone: string;
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
  due,
  timeZone,
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

  const [sort, setSort] = useState<ContactSort>("recent");
  const shown = useMemo(() => sortContacts(filterContacts(contacts, filters), sort), [contacts, filters, sort]);
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
        <select
          aria-label="Sort contacts"
          value={sort}
          onChange={(e) => setSort(e.target.value as ContactSort)}
          className="h-7 rounded border border-line bg-raised px-1 text-[12px] text-dim"
        >
          {(Object.keys(SORT_LABELS) as ContactSort[]).map((k) => (
            <option key={k} value={k}>
              sort: {SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-2">
          <Link href="/network/settings" className="text-[12px] text-dim hover:text-ink">
            Settings
          </Link>
          {!form && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setForm(emptyForm());
              }}
              className="rounded border border-accent bg-accent px-3 py-1 text-[12px] text-accent-ink"
            >
              Add contact
            </button>
          )}
        </div>
      </div>

      <section aria-label="Due" className="rounded border border-line bg-panel" data-testid="due-list">
        <h2 className="border-b border-line px-3 py-1.5 font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
          Due today{due.some((d) => d.overdue) ? " and overdue" : ""}
          <span className="ml-2 font-normal text-faint tabular-nums">{due.length}</span>
        </h2>
        {due.length === 0 ? (
          <p className="px-3 py-2 text-[12px] text-faint">Nothing due. Follow-ups, thank-yous and openers show up here on the day.</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {due.map((d) => {
              const when = dueWhen(d.dueAt, nowMs, timeZone);
              return (
                <li key={d.contactId} className="flex items-baseline gap-3 px-3 py-1.5 text-[13px]" data-testid="due-item">
                  <Link
                    href={`/network/${d.contactId}`}
                    className="font-medium text-ink hover:underline decoration-faint underline-offset-2"
                  >
                    {d.name}
                  </Link>
                  {d.company && <span className="text-dim">{d.company}</span>}
                  <span className="text-ink">{DUE_LABELS[d.kind]}</span>
                  <span className={`ml-auto font-mono text-[12px] ${when.overdue ? "text-bad" : "text-dim"}`}>
                    {when.text}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

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
            <col className="w-[10rem]" />
            <col className="w-[8rem]" />
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
              <th className={TH}>next</th>
              <th className={TH} title="Latest message in either direction">last</th>
              <th className={TH}>reach</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={8} className="px-2 py-6 text-center text-[12px] text-dim">
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
                    {c.status === "PENDING_CONNECTION" && c.pendingSince && (
                      <span className="ml-1 font-mono text-faint" title={`Connection note sent ${absoluteDate(c.pendingSince)}`}>
                        {relativeAge(c.pendingSince, nowMs)}
                      </span>
                    )}
                  </td>
                  <td className={`${TD} text-[12px]`}>
                    {c.nextFollowUpAt ? (
                      (() => {
                        const when = dueWhen(c.nextFollowUpAt, nowMs, timeZone);
                        return <span className={when.overdue ? "text-bad" : "text-dim"}>{when.text}</span>;
                      })()
                    ) : (
                      <span className="text-faint">—</span>
                    )}
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
