import type { Metadata } from "next";
import ImportContacts from "./ImportContacts";

export const metadata: Metadata = {
  title: "Import contacts · Internship Tracker",
  description: "Bulk-add contacts from a CSV or LinkedIn's Connections export.",
};

export default function ImportContactsPage() {
  return (
    <div className="flex flex-col gap-5 px-6 py-7 lg:px-10 lg:py-9">
      <ImportContacts />
    </div>
  );
}
