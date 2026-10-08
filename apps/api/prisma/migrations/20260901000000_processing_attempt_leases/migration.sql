-- Attempt ownership: overlapping worker executions inside one generation are
-- distinguished by an attempt identity with a renewable database lease.
ALTER TABLE "Video"
ADD COLUMN "processingAttemptId" UUID,
ADD COLUMN "processingLeaseExpiresAt" TIMESTAMP(3),
ADD COLUMN "committedAttemptId" UUID;

-- Generated assets record the attempt that produced them. Existing rows keep a
-- NULL attempt and remain the committed set for videos with a NULL committed attempt.
ALTER TABLE "VideoAsset"
ADD COLUMN "attemptId" UUID;
