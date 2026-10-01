import type { Metadata } from "next";
import ImportContacts from "./ImportContacts";

export const metadata: Metadata = {
  title: "Import contacts · Internship Tracker",
  description: "Bulk-add contacts from a CSV or LinkedIn's Connections export.",
};

export default function ImportContactsPage() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <ImportContacts />
    </div>
  );
}
