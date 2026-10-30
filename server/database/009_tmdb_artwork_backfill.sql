-- Tracks low-rate landscape artwork lookups without changing title metadata.
CREATE TABLE IF NOT EXISTS sc_tmdb_artwork_cache (
  title_id bigint PRIMARY KEY REFERENCES sc_titles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('complete','not_found','retry')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  last_error text
);

CREATE INDEX IF NOT EXISTS sc_tmdb_artwork_retry_idx
  ON sc_tmdb_artwork_cache(retry_after) WHERE status = 'retry';
