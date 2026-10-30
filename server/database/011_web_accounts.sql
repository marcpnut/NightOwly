-- The application account is independent of the Xtream provider credentials.
-- This installation uses one owner account, independent of provider credentials.
CREATE TABLE IF NOT EXISTS sc_web_accounts (
  id text PRIMARY KEY CHECK (id = 'primary'),
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
