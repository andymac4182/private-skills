

CREATE TABLE IF NOT EXISTS "private_skills_service_tokens" (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  role_ceiling text NOT NULL CHECK (role_ceiling IN ('owner', 'admin', 'publisher', 'reader')),
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz NULL
);
CREATE INDEX IF NOT EXISTS "private_skills_service_tokens_org_created_idx" ON "private_skills_service_tokens" (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "private_skills_service_tokens_hash_idx" ON "private_skills_service_tokens" (token_hash);
