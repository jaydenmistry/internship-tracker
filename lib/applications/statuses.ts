import type { AppStatus } from "@/generated/prisma/enums";

/**
 * Pipeline order — also the kanban column order. Lives in its own Prisma-free
 * module so client components can import it instead of keeping a copy.
 */
export const TRACKER_STATUSES = [
  "APPLIED",
  "OA",
  "PHONE_SCREEN",
  "INTERVIEW",
  "OFFER",
  "REJECTED",
  "CLOSED",
  "SKIPPED",
] as const satisfies readonly AppStatus[];

export type TrackerStatus = (typeof TRACKER_STATUSES)[number];
