-- Watch Later is a system playlist. Application checks provide friendly errors;
-- this constraint protects the invariant from concurrent or future write paths.
ALTER TABLE "Playlist"
ADD CONSTRAINT "Playlist_watch_later_private_check"
CHECK ("type" <> 'WATCH_LATER' OR "visibility" = 'PRIVATE');

-- Keep trigger resolution independent from a connection's mutable search_path.
CREATE OR REPLACE FUNCTION "public".refresh_video_search_vector()
RETURNS trigger AS $$
DECLARE channel_record "public"."Channel"%ROWTYPE;
BEGIN
  SELECT * INTO channel_record
  FROM "public"."Channel"
  WHERE "id" = NEW."channelId";

  NEW."searchVector" :=
    setweight(to_tsvector('english', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(channel_record."name", '') || ' ' || coalesce(channel_record."handle", '')), 'B') ||
    setweight(to_tsvector('english', coalesce(NEW."description", '')), 'C');
  RETURN NEW;
END
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION "public".refresh_channel_video_search_vectors()
RETURNS trigger AS $$
BEGIN
  UPDATE "public"."Video"
  SET "searchVector" =
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce(NEW."name", '') || ' ' || coalesce(NEW."handle", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  WHERE "channelId" = NEW."id";
  RETURN NEW;
END
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
