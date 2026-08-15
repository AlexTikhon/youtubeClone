ALTER TABLE "User" ADD COLUMN "passwordHash" VARCHAR(255);

UPDATE "User" SET "passwordHash" = 'legacy-account-must-reset';

ALTER TABLE "User" ALTER COLUMN "passwordHash" SET NOT NULL;

ALTER TABLE "Video"
ADD COLUMN "width" INTEGER,
ADD COLUMN "height" INTEGER;

ALTER TABLE "VideoAsset" ADD COLUMN "metadata" JSONB;
