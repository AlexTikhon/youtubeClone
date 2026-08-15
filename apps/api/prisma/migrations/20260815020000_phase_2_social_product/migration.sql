ALTER TYPE "VideoStatus" ADD VALUE 'DELETING';

CREATE TABLE "VideoLike" (
  "userId" UUID NOT NULL, "videoId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VideoLike_pkey" PRIMARY KEY ("userId", "videoId")
);
CREATE TABLE "Comment" (
  "id" UUID NOT NULL, "videoId" UUID NOT NULL, "authorId" UUID NOT NULL, "content" VARCHAR(2000) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "Subscription" (
  "subscriberId" UUID NOT NULL, "channelId" UUID NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("subscriberId", "channelId")
);
CREATE TABLE "VideoView" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "videoId" UUID NOT NULL, "windowStart" TIMESTAMP(3) NOT NULL,
  "viewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "VideoView_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "WatchHistory" (
  "userId" UUID NOT NULL, "videoId" UUID NOT NULL, "lastPositionSeconds" INTEGER NOT NULL,
  "lastWatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "WatchHistory_pkey" PRIMARY KEY ("userId", "videoId")
);

CREATE INDEX "VideoLike_videoId_idx" ON "VideoLike"("videoId");
CREATE INDEX "Comment_videoId_createdAt_id_idx" ON "Comment"("videoId", "createdAt" DESC, "id" DESC);
CREATE INDEX "Comment_authorId_idx" ON "Comment"("authorId");
CREATE INDEX "Subscription_channelId_idx" ON "Subscription"("channelId");
CREATE INDEX "Subscription_subscriberId_createdAt_idx" ON "Subscription"("subscriberId", "createdAt" DESC);
CREATE UNIQUE INDEX "VideoView_userId_videoId_windowStart_key" ON "VideoView"("userId", "videoId", "windowStart");
CREATE INDEX "VideoView_videoId_viewedAt_idx" ON "VideoView"("videoId", "viewedAt" DESC);
CREATE INDEX "WatchHistory_userId_lastWatchedAt_videoId_idx" ON "WatchHistory"("userId", "lastWatchedAt" DESC, "videoId" DESC);
DROP INDEX IF EXISTS "Video_visibility_publishedAt_idx";
CREATE INDEX "Video_status_visibility_publishedAt_id_idx" ON "Video"("status", "visibility", "publishedAt" DESC, "id" DESC);

ALTER TABLE "VideoLike" ADD CONSTRAINT "VideoLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoLike" ADD CONSTRAINT "VideoLike_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "Channel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoView" ADD CONSTRAINT "VideoView_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VideoView" ADD CONSTRAINT "VideoView_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WatchHistory" ADD CONSTRAINT "WatchHistory_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;
