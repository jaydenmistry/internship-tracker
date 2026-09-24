import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadCompanyNames, loadContact } from "@/lib/networking/contacts";
import ContactView from "./ContactView";

export const metadata: Metadata = {
  title: "Contact · Internship Tracker",
  description: "One contact's details.",
};

export const dynamic = "force-dynamic";

export default async function ContactPage({ params }: PageProps<"/network/[id]">) {
  const { id } = await params;
  const contact = await loadContact(id);
  if (!contact) notFound();
  const companyNames = await loadCompanyNames();

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <ContactView contact={contact} companyNames={companyNames} nowIso={new Date().toISOString()} />
    </div>
  );
}
