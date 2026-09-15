

CREATE TABLE IF NOT EXISTS "private_skills_company_sso_providers" (
  id text PRIMARY KEY,
  organization_id text NOT NULL,
  provider_id text NOT NULL UNIQUE,
  display_name text NOT NULL,
  protocol text NOT NULL CHECK (protocol IN ('oidc', 'saml')),
  issuer text NOT NULL,
  callback_url text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  oidc_config jsonb NULL,
  saml_config jsonb NULL,
  created_by text NOT NULL,
  updated_by text NOT NULL,
  revision bigint NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((protocol = 'oidc' AND oidc_config IS NOT NULL AND saml_config IS NULL)
      OR (protocol = 'saml' AND oidc_config IS NULL AND saml_config IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "private_skills_company_sso_providers_organization_created_idx" ON "private_skills_company_sso_providers" (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS "private_skills_company_sso_providers_issuer_idx" ON "private_skills_company_sso_providers" (issuer);
