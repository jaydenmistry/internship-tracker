-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "gateScore" INTEGER;

-- CreateIndex
CREATE INDEX "Listing_gateScore_idx" ON "Listing"("gateScore");

