"use client";

import { Fragment } from "react";
import type { AppStatus } from "@/generated/prisma/enums";
import type { TrackerApplication } from "@/lib/applications/tracker";
import { ApplyLink, Markers, RelDate, StatusSelect } from "./bits";
import { NotesEditor, NotesPreview, type NotesApi } from "./NotesEditor";
import { safeHttpUrl } from "./state";

interface Props {
  apps: TrackerApplication[];
  nowMs: number;
  onStatus: (id: string, status: AppStatus) => void;
  notes: NotesApi;
  emptyHint: React.ReactNode;
}

const TH = "px-2 py-1 text-left text-[11px] font-normal text-faint";
const TD = "px-2 py-1 align-top";

/** Dense table. Fixed layout so long scraped titles truncate instead of widening the page. */
export default function ListView({ apps, nowMs, onStatus, notes, emptyHint }: Props) {
  return (
    <div className="rounded border border-line bg-panel">
      <table className="w-full table-fixed border-collapse" data-testid="tracker-list">
        <colgroup>
          <col className="w-[11rem]" />
          <col />
          <col className="w-[9rem]" />
          <col className="w-[8.5rem]" />
          <col className="w-[4.5rem]" />
          <col className="w-[4.5rem]" />
          <col className="w-[4rem]" />
          <col className="w-[16rem]" />
          <col className="w-[3.5rem]" />
        </colgroup>
        <thead className="border-b border-line">
          <tr>
            <th className={TH}>company</th>
            <th className={TH}>role</th>
            <th className={TH}>location</th>
            <th className={TH}>status</th>
            <th className={TH}>applied</th>
            <th className={TH} title="Last status change">changed</th>
            <th className={`${TH} text-right`}>score</th>
            <th className={TH}>notes</th>
            <th className={TH}>link</th>
          </tr>
        </thead>
        <tbody>
          {apps.length === 0 && (
            <tr>
              <td colSpan={9} className="px-2 py-6 text-center text-[12px] text-dim">
                {emptyHint}
              </td>
            </tr>
          )}
          {apps.map((app) => {
            const href = safeHttpUrl(app.url);
            return (
              <Fragment key={app.id}>
                <tr data-testid="tracker-row" className="border-b border-line-soft hover:bg-raised/50">
                  <td className={TD}>
                    <div className="flex min-w-0 items-center gap-1">
                      <ApplyLink app={app} className="truncate font-medium text-ink">
                        <span title={app.company}>{app.company}</span>
                      </ApplyLink>
                    </div>
                  </td>
                  <td className={TD}>
                    <div className="flex min-w-0 items-center gap-1">
                      <ApplyLink app={app} className="min-w-0 truncate text-dim">
                        <span title={app.role}>{app.role}</span>
                      </ApplyLink>
                      <Markers app={app} />
                    </div>
                  </td>
                  <td className={`${TD} truncate text-dim`} title={app.location ?? undefined}>
                    {app.location ?? <span className="text-faint">—</span>}
                  </td>
                  <td className={TD}>
                    <StatusSelect app={app} onChange={(s) => onStatus(app.id, s)} className="w-full" />
                  </td>
                  <td className={`${TD} text-[12px] text-dim`}>
                    <RelDate iso={app.appliedAt} nowMs={nowMs} />
                  </td>
                  <td className={`${TD} text-[12px] text-dim`}>
                    <RelDate iso={app.lastEventAt ?? app.updatedAt} nowMs={nowMs} />
                  </td>
                  <td className={`${TD} text-right font-mono tabular-nums text-dim`}>
                    {app.score ?? <span className="text-faint">—</span>}
                  </td>
                  <td className={TD}>
                    <NotesPreview app={app} notes={notes} />
                  </td>
                  <td className={TD}>
                    {href ? (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[12px] text-accent hover:underline"
                        title={href}
                      >
                        open ↗
                      </a>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </td>
                </tr>
                {notes.isOpen(app.id) && (
                  <tr className="border-b border-line-soft bg-raised/30">
                    <td colSpan={7} />
                    <td colSpan={2} className={TD}>
                      <NotesEditor app={app} notes={notes} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
