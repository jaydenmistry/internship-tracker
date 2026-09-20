-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "previousScore" INTEGER,
ADD COLUMN     "scoreMoved" BOOLEAN NOT NULL DEFAULT false;

-- Backfill the baseline from the scores already stored. Without this, the first
-- ranking run after this migration would compare every finalScore against NULL,
-- read that as "this listing's own score changed", and light up every arrow in
-- the table exactly once — the noise the flag exists to remove.
UPDATE "Listing" SET "previousScore" = "finalScore" WHERE "finalScore" IS NOT NULL;
