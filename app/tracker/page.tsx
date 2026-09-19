import type { Metadata } from "next";
import { loadDashboardStats, loadTrackerApplications } from "@/lib/applications/tracker";
import Dashboard from "./Dashboard";
import TrackerView from "./TrackerView";

export const metadata: Metadata = {
  title: "Tracker · Internship Tracker",
  description: "Applications by stage, with notes and a response-rate summary.",
};

// Always read current applications — status changes call refresh().
export const dynamic = "force-dynamic";

export default async function TrackerPage({ searchParams }: PageProps<"/tracker">) {
  const { view } = await searchParams;
  // Sequential on purpose: two concurrent queries through the `prisma dev`
  // proxy intermittently fail with "bind message supplies N parameters". Both
  // are tiny (one row per application), so there is nothing to gain from racing.
  const apps = await loadTrackerApplications();
  const stats = await loadDashboardStats();

  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <Dashboard stats={stats} />
      <TrackerView apps={apps} view={view === "list" ? "list" : "kanban"} nowIso={new Date().toISOString()} />
    </div>
  );
}
