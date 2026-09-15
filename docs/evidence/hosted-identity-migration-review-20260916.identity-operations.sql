
CREATE TABLE IF NOT EXISTS "private_skills_identity_operations_events" (
  id text PRIMARY KEY,
  occurred_at timestamptz NOT NULL,
  event_kind text NOT NULL CHECK (event_kind IN ('authentication_failure', 'callback_failure', 'membership_denial')),
  reason_code text NOT NULL CHECK (reason_code IN ('unknown_failure', 'session_unavailable', 'authentication_rejected', 'callback_rejected', 'callback_unavailable', 'membership_missing', 'membership_role_denied', 'tenant_mismatch')),
  provider_id text,
  organization_id text,
  role text CHECK (role IS NULL OR role IN ('owner', 'admin', 'publisher', 'reader')),
  CHECK ((organization_id IS NULL AND role IS NULL) OR (organization_id IS NOT NULL AND role IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS "private_skills_identity_operations_events_organization_time" ON "private_skills_identity_operations_events" (organization_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS "private_skills_identity_operations_events_kind_time" ON "private_skills_identity_operations_events" (event_kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS "private_skills_identity_operations_events_occurred_time" ON "private_skills_identity_operations_events" (occurred_at ASC);
