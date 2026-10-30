-- Canonical titles are separate from provider stream variants.  Credentials stay
-- encrypted in provider_config; stream URLs are assembled only at playback time.
CREATE TABLE IF NOT EXISTS sections (
  id smallint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code IN ('movie','series','live')),
  name text NOT NULL
);
INSERT INTO sections(code,name) VALUES ('movie','Movie'),('series','Series'),('live','Live TV') ON CONFLICT(code) DO NOTHING;

CREATE TABLE IF NOT EXISTS languages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code text UNIQUE,
  name text NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS media_items (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('movie','series','live')),
  canonical_key text NOT NULL UNIQUE,
  title text NOT NULL,
  original_title text,
  description text,
  release_year integer,
  poster_url text,
  backdrop_url text,
  genre text,
  rating numeric(4,2),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS media_items_kind_title_idx ON media_items(kind,title);
CREATE TABLE IF NOT EXISTS provider_streams (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  media_item_id bigint NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  provider_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('movie','series','live','episode')),
  parent_provider_id text,
  season_number integer,
  episode_number integer,
  category_id text,
  title text NOT NULL,
  stream_extension text,
  path_template text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(kind,provider_id)
);
CREATE INDEX IF NOT EXISTS provider_streams_media_idx ON provider_streams(media_item_id,active);
CREATE TABLE IF NOT EXISTS categories_v2 (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_category_id text NOT NULL,
  name text NOT NULL,
  UNIQUE(provider_category_id,name)
);
CREATE TABLE IF NOT EXISTS media_sections (
  media_item_id bigint NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  section_id smallint NOT NULL REFERENCES sections(id),
  PRIMARY KEY(media_item_id,section_id)
);
CREATE TABLE IF NOT EXISTS media_languages (
  media_item_id bigint NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  language_id bigint NOT NULL REFERENCES languages(id),
  PRIMARY KEY(media_item_id,language_id)
);
CREATE TABLE IF NOT EXISTS stream_languages (
  stream_id bigint NOT NULL REFERENCES provider_streams(id) ON DELETE CASCADE,
  language_id bigint NOT NULL REFERENCES languages(id),
  PRIMARY KEY(stream_id,language_id)
);
CREATE TABLE IF NOT EXISTS media_categories (
  media_item_id bigint NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  category_id bigint NOT NULL REFERENCES categories_v2(id),
  PRIMARY KEY(media_item_id,category_id)
);
CREATE TABLE IF NOT EXISTS stream_categories (
  stream_id bigint NOT NULL REFERENCES provider_streams(id) ON DELETE CASCADE,
  category_id bigint NOT NULL REFERENCES categories_v2(id),
  PRIMARY KEY(stream_id,category_id)
);
CREATE TABLE IF NOT EXISTS category_sections (
  category_id bigint NOT NULL REFERENCES categories_v2(id) ON DELETE CASCADE,
  section_id smallint NOT NULL REFERENCES sections(id),
  PRIMARY KEY(category_id,section_id)
);
CREATE TABLE IF NOT EXISTS category_languages (
  category_id bigint NOT NULL REFERENCES categories_v2(id) ON DELETE CASCADE,
  language_id bigint NOT NULL REFERENCES languages(id),
  PRIMARY KEY(category_id,language_id)
);
CREATE TABLE IF NOT EXISTS episodes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  stream_id bigint NOT NULL UNIQUE REFERENCES provider_streams(id) ON DELETE CASCADE,
  series_media_item_id bigint NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
  season_number integer NOT NULL DEFAULT 0,
  episode_number integer NOT NULL DEFAULT 0,
  title text NOT NULL,
  description text,
  poster_url text,
  UNIQUE(series_media_item_id,season_number,episode_number,stream_id)
);
CREATE INDEX IF NOT EXISTS episodes_season_idx ON episodes(series_media_item_id,season_number,episode_number);
