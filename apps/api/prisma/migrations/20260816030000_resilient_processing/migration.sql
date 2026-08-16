ALTER TABLE "Video"
ADD COLUMN "processingGeneration" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "processingStartedAt" TIMESTAMP(3),
ADD COLUMN "processingFinishedAt" TIMESTAMP(3);

-- Existing submitted videos predate explicit generations and belong to logical run 1.
UPDATE "Video"
SET "processingGeneration" = 1
WHERE "status" IN ('UPLOADED', 'PROCESSING', 'READY', 'FAILED');

CREATE TABLE "ProcessingOutbox" (
  "id" UUID NOT NULL,
  "videoId" UUID NOT NULL,
  "generation" INTEGER NOT NULL,
  "originalAssetId" UUID NOT NULL,
  "correlationId" VARCHAR(100) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMP(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(500),
  CONSTRAINT "ProcessingOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProcessingOutbox_videoId_generation_key"
ON "ProcessingOutbox"("videoId", "generation");
CREATE INDEX "ProcessingOutbox_publishedAt_createdAt_idx"
ON "ProcessingOutbox"("publishedAt", "createdAt");

ALTER TABLE "ProcessingOutbox"
ADD CONSTRAINT "ProcessingOutbox_videoId_fkey"
FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
