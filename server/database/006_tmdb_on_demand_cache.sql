-- Lightweight request cache for on-demand TMDB details and season episode lists.
CREATE TABLE IF NOT EXISTS sc_tmdb_settings (
  id text PRIMARY KEY CHECK (id = 'primary'),
  token_cipher text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sc_tmdb_title_cache (
  title_id bigint PRIMARY KEY REFERENCES sc_titles(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('complete','not_found','retry')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  last_error text
);

CREATE TABLE IF NOT EXISTS sc_tmdb_season_cache (
  series_title_id bigint NOT NULL REFERENCES sc_titles(id) ON DELETE CASCADE,
  season_number integer NOT NULL,
  language_code text NOT NULL,
  status text NOT NULL CHECK (status IN ('complete','not_found','retry')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  retry_after timestamptz,
  last_error text,
  PRIMARY KEY(series_title_id,season_number,language_code)
);
