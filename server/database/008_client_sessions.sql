-- Short-lived, revocable client sessions issued after NightOwl account authentication.
CREATE TABLE IF NOT EXISTS sc_client_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  device_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sc_client_sessions_device_expiry_idx
  ON sc_client_sessions(device_id,expires_at)
  WHERE revoked_at IS NULL;
