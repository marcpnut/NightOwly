CREATE TABLE IF NOT EXISTS sc_catalog_import_runs (
  id uuid PRIMARY KEY,
  source text NOT NULL,
  status text NOT NULL CHECK (status IN ('running','success','error')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  added_live integer NOT NULL DEFAULT 0,
  added_movies integer NOT NULL DEFAULT 0,
  added_series integer NOT NULL DEFAULT 0,
  added_episodes integer NOT NULL DEFAULT 0,
  message text
);

ALTER TABLE sc_provider_streams ADD COLUMN IF NOT EXISTS import_run_id uuid
  REFERENCES sc_catalog_import_runs(id);
CREATE INDEX IF NOT EXISTS sc_provider_streams_import_run_idx
  ON sc_provider_streams(import_run_id, kind) WHERE import_run_id IS NOT NULL;
