-- CreateEnum
CREATE TYPE "ContactKind" AS ENUM ('RECRUITER', 'ENGINEER', 'HIRING_MANAGER', 'ALUMNI', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactStatus" AS ENUM ('NOT_CONTACTED', 'PENDING_CONNECTION', 'AWAITING_REPLY', 'REPLIED', 'CHATTED', 'REFERRED', 'COLD');

-- CreateEnum
CREATE TYPE "OutreachDirection" AS ENUM ('OUT', 'IN');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('EMAIL', 'LINKEDIN', 'IN_PERSON', 'OTHER');

-- CreateEnum
CREATE TYPE "OutreachType" AS ENUM ('COLD', 'CONNECT_NOTE', 'ACCEPTED', 'MEETING', 'FOLLOW_UP', 'THANK_YOU', 'REFERRAL_ASK', 'REPLY');

-- AlterTable
ALTER TABLE "Application" ADD COLUMN     "referredByContactId" TEXT;

-- CreateTable
CREATE TABLE "Contact" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "companyId" TEXT,
    "title" TEXT,
    "kind" "ContactKind" NOT NULL DEFAULT 'OTHER',
    "email" TEXT,
    "linkedinUrl" TEXT,
    "howMet" TEXT,
    "notes" TEXT,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "manualStatus" "ContactStatus",
    "manualStatusAt" TIMESTAMP(3),
    "followUpOverrideAt" TIMESTAMP(3),
    "status" "ContactStatus" NOT NULL DEFAULT 'NOT_CONTACTED',
    "nextFollowUpAt" TIMESTAMP(3),
    "followUpsSent" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachMessage" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "direction" "OutreachDirection" NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "type" "OutreachType" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "draftBody" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "listingId" TEXT,
    "applicationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Contact_companyId_idx" ON "Contact"("companyId");

-- CreateIndex
CREATE INDEX "Contact_nextFollowUpAt_idx" ON "Contact"("nextFollowUpAt");

-- CreateIndex
CREATE INDEX "Contact_status_idx" ON "Contact"("status");

-- CreateIndex
CREATE INDEX "OutreachMessage_contactId_sentAt_idx" ON "OutreachMessage"("contactId", "sentAt");

-- CreateIndex
CREATE INDEX "OutreachMessage_listingId_idx" ON "OutreachMessage"("listingId");

-- CreateIndex
CREATE INDEX "OutreachMessage_applicationId_idx" ON "OutreachMessage"("applicationId");

-- CreateIndex
CREATE INDEX "Application_referredByContactId_idx" ON "Application"("referredByContactId");

-- AddForeignKey
ALTER TABLE "Application" ADD CONSTRAINT "Application_referredByContactId_fkey" FOREIGN KEY ("referredByContactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_listingId_fkey" FOREIGN KEY ("listingId") REFERENCES "Listing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachMessage" ADD CONSTRAINT "OutreachMessage_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE SET NULL ON UPDATE CASCADE;

