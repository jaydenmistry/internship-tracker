-- AlterTable
ALTER TABLE "Listing" ADD COLUMN     "previousRank" INTEGER,
ADD COLUMN     "rank" INTEGER,
ADD COLUMN     "rankChangedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Listing_rank_idx" ON "Listing"("rank");

