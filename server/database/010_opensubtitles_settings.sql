CREATE TABLE IF NOT EXISTS sc_opensubtitles_settings (
  id text PRIMARY KEY CHECK (id='primary'),
  api_key_cipher text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
