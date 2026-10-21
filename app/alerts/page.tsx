import type { Metadata } from "next";
import { loadAlertSettings } from "@/lib/alerts/config";
import { loadRecentAlerts } from "@/lib/alerts/data";
import { channelAvailability } from "@/lib/alerts/send";
import PageHeader from "@/components/PageHeader";
import AlertsView from "./AlertsView";

export const metadata: Metadata = {
  title: "Alerts · Internship Tracker",
  description: "Alert thresholds, manual triggers, and the log of what was delivered.",
};

// The alert log changes from outside this page (the worker's cron), so there is
// nothing worth caching here.
export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  // Sequential, like /tracker: two concurrent queries through the `prisma dev`
  // proxy intermittently fail with "bind message supplies N parameters", and
  // both of these are tiny.
  const settings = await loadAlertSettings();
  const recent = await loadRecentAlerts(50);

  // Derived on the server from env; only the channel name, a ready flag and a
  // reason cross to the client — never the webhook URL or SMTP credentials.
  const channels = channelAvailability(settings);

  return (
    <div className="flex flex-col gap-5 px-6 py-7 lg:px-10 lg:py-9">
      <PageHeader
        title="Alerts"
        description="When the worker tells you about new listings, high scores and deadlines, and where it sends them."
      />
      <AlertsView settings={settings} recent={recent} channels={channels} />
    </div>
  );
}
