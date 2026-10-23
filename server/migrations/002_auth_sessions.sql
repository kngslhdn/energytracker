CREATE TABLE IF NOT EXISTS auth_sessions (
 id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 token_hash CHAR(64) NOT NULL UNIQUE,
 user_id UUID NOT NULL REFERENCES app_users(id),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions(expires_at);
