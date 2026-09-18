-- CreateEnum
CREATE TYPE "AppStatus" AS ENUM ('NOT_APPLIED', 'APPLIED', 'OA', 'PHONE_SCREEN', 'INTERVIEW', 'OFFER', 'REJECTED', 'CLOSED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "AlertKind" AS ENUM ('DAILY_DIGEST', 'HIGH_SCORE', 'CLOSING_SOON');

-- CreateEnum
CREATE TYPE "AlertChannel" AS ENUM ('DISCORD', 'EMAIL');

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "faangPlus" BOOLEAN NOT NULL DEFAULT false,
    "tierOverride" INTEGER,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Listing" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "dedupKey" TEXT NOT NULL,
    "locations" TEXT[],
    "countries" TEXT[],
    "remote" BOOLEAN NOT NULL DEFAULT false,
    "url" TEXT NOT NULL,
    "requisitionId" TEXT,
    "postingText" TEXT,
    "postingTextHash" TEXT,
    "category" TEXT,
    "terms" TEXT[],
    "sponsorship" TEXT,
    "degrees" TEXT[],
    "postedAt" TIMESTAMP(3),
    "deadline" TIMESTAMP(3),
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "likelyClosed" BOOLEAN NOT NULL DEFAULT false,
    "saved" BOOLEAN NOT NULL DEFAULT false,
    "dismissed" BOOLEAN NOT NULL DEFAULT false,
    "mergedFrom" JSONB[],
    "atsKind" TEXT,
    "detailFetchedAt" TIMESTAMP(3),
    "detailFetchStatus" TEXT,
    "ruleScore" INTEGER,
    "llmAdjustment" INTEGER,
    "finalScore" INTEGER,
    "scoreBreakdown" JSONB,
    "disqualified" BOOLEAN NOT NULL DEFAULT false,
    "disqualifyReasons" TEXT[],
    "scoredAt" TIMESTAMP(3),
    "scoringConfigHash" TEXT,

    CONSTRAINT "Listing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ListingSource" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sourceUid" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL,
    "firstSeen" TIMESTAMP(3) NOT NULL,
    "lastSeen" TIMESTAMP(3) NOT NULL,
    "raw" JSONB NOT NULL,

    CONSTRAINT "ListingSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "ok" BOOLEAN NOT NULL DEFAULT false,
    "itemsSeen" INTEGER,
    "itemsNew" INTEGER,
    "itemsUpdated" INTEGER,
    "itemsClosed" INTEGER,
    "error" TEXT,
    "rawGz" BYTEA,
    "rawSha256" TEXT,

    CONSTRAINT "IngestRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmAssessment" (
    "id" TEXT NOT NULL,
    "listingId" TEXT NOT NULL,
    "textHash" TEXT NOT NULL,
    "adjustment" INTEGER NOT NULL,
    "rationale" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmAssessment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL,
    "listingId" TEXT,
    "companyName" TEXT,
    "roleTitle" TEXT,
    "location" TEXT,
    "status" "AppStatus" NOT NULL,
    "appliedAt" TIMESTAMP(3),
    "requisitionId" TEXT,
    "applyUrl" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Application_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatusEvent" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "fromStatus" "AppStatus",
    "toStatus" "AppStatus" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "StatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Resume" (
    "id" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "text" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Resume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "AlertLog" (
    "id" TEXT NOT NULL,
    "kind" "AlertKind" NOT NULL,
    "channel" "AlertChannel" NOT NULL,
    "listingId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_normalizedName_key" ON "Company"("normalizedName");

-- CreateIndex
CREATE INDEX "Listing_dedupKey_idx" ON "Listing"("dedupKey");

-- CreateIndex
CREATE INDEX "Listing_companyId_idx" ON "Listing"("companyId");

-- CreateIndex
CREATE INDEX "Listing_finalScore_idx" ON "Listing"("finalScore");

-- CreateIndex
CREATE INDEX "Listing_likelyClosed_dismissed_idx" ON "Listing"("likelyClosed", "dismissed");

-- CreateIndex
CREATE INDEX "ListingSource_listingId_idx" ON "ListingSource"("listingId");

-- CreateIndex
CREATE UNIQUE INDEX "ListingSource_source_sourceUid_key" ON "ListingSource"("source", "sourceUid");

-- CreateIndex
CREATE INDEX "IngestRun_source_startedAt_idx" ON "IngestRun"("source", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "LlmAssessment_listingId_textHash_key" ON "LlmAssessment"("listingId", "textHash");

-- CreateIndex
CREATE UNIQUE INDEX "Application_listingId_key" ON "Application"("listingId");

-- CreateIndex
CREATE INDEX "StatusEvent_applicationId_idx" ON "StatusEvent"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "AlertLog_dedupeKey_key" ON "AlertLog"("dedupeKey");

-- AddForeignKey
ALTER TABLE "Listing" ADD CONSTRAINT "Listing_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ListingSource" ADD CONSTRAINT "ListingSource_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmAssessment" ADD CONSTRAINT "LlmAssessment_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatusEvent" ADD CONSTRAINT "StatusEvent_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
