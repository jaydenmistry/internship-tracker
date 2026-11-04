-- CreateTable
CREATE TABLE "JobBoard" (
    "id" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "companyName" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastCheckedAt" TIMESTAMP(3),
    "lastStatus" TEXT,
    "lastJobCount" INTEGER,
    "lastInternCount" INTEGER,
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "JobBoard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JobBoard_key_key" ON "JobBoard"("key");
