import type { Metadata } from "next";
import { loadNetworkingSettings } from "@/lib/networking/followups";
import SettingsForm from "./SettingsForm";
import { draftingConfigured } from "@/lib/claude/draftClient";
import { draftModel } from "@/lib/networking/drafting";

export const metadata: Metadata = {
  title: "Network settings · Internship Tracker",
  description: "Follow-up cadence and the voice notes drafts are written from.",
};

export const dynamic = "force-dynamic";

export default async function NetworkSettingsPage() {
  const settings = await loadNetworkingSettings();
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <SettingsForm settings={settings} claude={{ connected: draftingConfigured(), model: draftModel() }} />
    </div>
  );
}
