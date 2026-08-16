CREATE TYPE "PlaylistVisibility" AS ENUM ('PRIVATE', 'PUBLIC');
CREATE TYPE "PlaylistType" AS ENUM ('STANDARD', 'WATCH_LATER');

CREATE TABLE "Playlist" (
  "id" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "title" VARCHAR(120) NOT NULL,
  "description" VARCHAR(1000),
  "visibility" "PlaylistVisibility" NOT NULL DEFAULT 'PRIVATE',
  "type" "PlaylistType" NOT NULL DEFAULT 'STANDARD',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Playlist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PlaylistItem" (
  "playlistId" UUID NOT NULL,
  "videoId" UUID NOT NULL,
  "position" INTEGER NOT NULL,
  "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlaylistItem_pkey" PRIMARY KEY ("playlistId", "videoId")
);

CREATE INDEX "Playlist_ownerId_updatedAt_id_idx" ON "Playlist"("ownerId", "updatedAt" DESC, "id" DESC);
CREATE UNIQUE INDEX "Playlist_ownerId_watchLater_key" ON "Playlist"("ownerId") WHERE "type" = 'WATCH_LATER';
CREATE UNIQUE INDEX "PlaylistItem_playlistId_position_key" ON "PlaylistItem"("playlistId", "position");
CREATE INDEX "PlaylistItem_videoId_idx" ON "PlaylistItem"("videoId");

ALTER TABLE "Playlist" ADD CONSTRAINT "Playlist_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "Playlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PlaylistItem" ADD CONSTRAINT "PlaylistItem_videoId_fkey" FOREIGN KEY ("videoId") REFERENCES "Video"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- PostgreSQL FTS is maintained in the database because the searchable document
-- includes Channel fields and Prisma cannot model a generated cross-table column.
ALTER TABLE "Video" ADD COLUMN "searchVector" tsvector;

CREATE FUNCTION refresh_video_search_vector() RETURNS trigger AS $$
DECLARE channel_record "Channel"%ROWTYPE;
BEGIN
  SELECT * INTO channel_record FROM "Channel" WHERE "id" = NEW."channelId";
  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(channel_record."name", '') || ' ' || coalesce(channel_record."handle", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW."description", '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Video_refresh_search_vector"
BEFORE INSERT OR UPDATE OF "title", "description", "channelId" ON "Video"
FOR EACH ROW EXECUTE FUNCTION refresh_video_search_vector();

CREATE FUNCTION refresh_channel_video_search_vectors() RETURNS trigger AS $$
BEGIN
  UPDATE "Video"
  SET "searchVector" =
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW."name", '') || ' ' || coalesce(NEW."handle", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  WHERE "channelId" = NEW."id";
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Channel_refresh_video_search_vectors"
AFTER UPDATE OF "name", "handle" ON "Channel"
FOR EACH ROW EXECUTE FUNCTION refresh_channel_video_search_vectors();

UPDATE "Video" AS video
SET "searchVector" =
  setweight(to_tsvector('english', coalesce(video."title", '')), 'A') ||
  setweight(to_tsvector('english', coalesce(channel_record."name", '') || ' ' || coalesce(channel_record."handle", '')), 'B') ||
  setweight(to_tsvector('english', coalesce(video."description", '')), 'C')
FROM "Channel" AS channel_record
WHERE channel_record."id" = video."channelId";

CREATE INDEX "Video_public_searchVector_idx" ON "Video" USING GIN ("searchVector")
WHERE "status" = 'READY' AND "visibility" = 'PUBLIC';
