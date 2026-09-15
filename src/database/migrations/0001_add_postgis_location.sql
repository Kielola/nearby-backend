-- Drizzle can't express PostGIS types, so this migration is hand-written
-- rather than generated. This is the normal, accepted pattern when using
-- Drizzle (or most JS ORMs) alongside PostGIS.

-- A GENERATED column: Postgres computes "location" automatically from
-- latitude/longitude on every insert/update. We never write to it
-- directly, and it can never drift out of sync with lat/lng.
ALTER TABLE "users"
  ADD COLUMN "location" geography(Point, 4326)
  GENERATED ALWAYS AS (
    CASE
      WHEN "latitude" IS NOT NULL AND "longitude" IS NOT NULL
      THEN ST_SetSRID(ST_MakePoint("longitude", "latitude"), 4326)::geography
      ELSE NULL
    END
  ) STORED;

-- A GIST index is what makes "find everyone within 2km" fast instead of
-- a full table scan computing distance for every row.
CREATE INDEX "users_location_gist_idx" ON "users" USING GIST ("location");
