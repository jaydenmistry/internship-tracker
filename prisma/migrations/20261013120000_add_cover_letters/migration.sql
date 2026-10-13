-- CreateTable
CREATE TABLE "CoverLetter" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "greeting" TEXT,
    "recipient" TEXT,
    "draftBody" TEXT,
    "postingText" TEXT,
    "checks" TEXT[],
    "model" TEXT,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoverLetter_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CoverLetter_applicationId_key" ON "CoverLetter"("applicationId");

-- AddForeignKey
ALTER TABLE "CoverLetter" ADD CONSTRAINT "CoverLetter_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
