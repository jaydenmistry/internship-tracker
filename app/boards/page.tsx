import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";
import { listBoards, PAUSE_AFTER_FAILURES } from "@/lib/ingestion/boards/store";
import BoardsView from "./BoardsView";

export const metadata: Metadata = {
  title: "Job boards · Internship Tracker",
  description: "Company job boards checked for new internships on every refresh.",
};

export const dynamic = "force-dynamic";

export default async function BoardsPage() {
  const boards = await listBoards();
  return (
    <div className="flex flex-col gap-5 px-6 py-7 lg:px-10 lg:py-9">
      <PageHeader
        title="Job boards"
        description="Company boards on Greenhouse, Lever and Ashby, checked for tech internships on every refresh. A board is added by itself the first time a listing links to it."
      />
      <BoardsView boards={boards} pauseAfter={PAUSE_AFTER_FAILURES} />
    </div>
  );
}
