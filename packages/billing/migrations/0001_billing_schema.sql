
CREATE TABLE IF NOT EXISTS "private_skills_billing_customers" (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  customer_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, customer_id)
);

CREATE TABLE IF NOT EXISTS "private_skills_billing_subscriptions" (
  organization_id text PRIMARY KEY,
  provider text NOT NULL,
  subscription_id text NOT NULL,
  customer_id text NOT NULL,
  price_id text NOT NULL,
  plan_id text NOT NULL,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  event_created_at bigint NOT NULL,
  last_event_id text NOT NULL,
  source text NOT NULL DEFAULT 'verified-webhook',
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, subscription_id),
  CHECK (event_created_at >= 0),
  CHECK (source = 'verified-webhook')
);

CREATE TABLE IF NOT EXISTS "private_skills_billing_usage" (
  organization_id text PRIMARY KEY,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  seats bigint NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  scans bigint NOT NULL DEFAULT 0,
  eve_cost_cents bigint NOT NULL DEFAULT 0,
  seat_baseline bigint NOT NULL DEFAULT 0,
  seat_reservations jsonb NOT NULL DEFAULT '[]'::jsonb,
  seat_revision bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK (seats >= 0),
  CHECK (storage_bytes >= 0),
  CHECK (scans >= 0),
  CHECK (eve_cost_cents >= 0),
  CHECK (seat_baseline >= 0),
  CHECK (seat_revision >= 0),
  CHECK (jsonb_typeof(seat_reservations) = 'array')
);

ALTER TABLE "private_skills_billing_usage"
  ADD COLUMN IF NOT EXISTS seat_baseline bigint NOT NULL DEFAULT 0;
ALTER TABLE "private_skills_billing_usage"
  ADD COLUMN IF NOT EXISTS seat_reservations jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE "private_skills_billing_usage"
  ADD COLUMN IF NOT EXISTS seat_revision bigint NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "private_skills_billing_webhook_events" (
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  organization_id text,
  created_at bigint NOT NULL,
  received_at timestamptz NOT NULL,
  payload_digest text NOT NULL,
  handled boolean NOT NULL DEFAULT false,
  ignored_reason text,
  PRIMARY KEY (provider, event_id),
  CHECK (created_at >= 0)
);

CREATE TABLE IF NOT EXISTS "private_skills_billing_usage_operations" (
  organization_id text NOT NULL,
  operation_key text NOT NULL,
  seats_delta bigint,
  storage_bytes_delta bigint,
  scans_delta bigint,
  eve_cost_cents_delta bigint,
  usage_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'reserved',
  reconciled jsonb,
  restoration jsonb,
  reservation_generation bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (organization_id, operation_key)
);

ALTER TABLE "private_skills_billing_usage_operations"
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'reserved';
ALTER TABLE "private_skills_billing_usage_operations"
  ADD COLUMN IF NOT EXISTS reconciled jsonb;
ALTER TABLE "private_skills_billing_usage_operations"
  ADD COLUMN IF NOT EXISTS restoration jsonb;
ALTER TABLE "private_skills_billing_usage_operations"
  ADD COLUMN IF NOT EXISTS reservation_generation bigint NOT NULL DEFAULT 1;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS existing_constraint
     WHERE existing_constraint.conname = 'private_skills_billing_operations_status_check'
       AND existing_constraint.conrelid = to_regclass('"private_skills_billing_usage_operations"')
  ) THEN
    ALTER TABLE "private_skills_billing_usage_operations"
      ADD CONSTRAINT "private_skills_billing_operations_status_check"
      CHECK (status IN ('reserved', 'committed', 'released'));
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint AS existing_constraint
     WHERE existing_constraint.conname = 'private_skills_billing_op_generation_check'
       AND existing_constraint.conrelid = to_regclass('"private_skills_billing_usage_operations"')
  ) THEN
    ALTER TABLE "private_skills_billing_usage_operations"
      ADD CONSTRAINT "private_skills_billing_op_generation_check"
      CHECK (reservation_generation >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "private_skills_billing_events_org_idx"
  ON "private_skills_billing_webhook_events" (organization_id, received_at DESC);
CREATE INDEX IF NOT EXISTS "private_skills_billing_operations_org_idx"
  ON "private_skills_billing_usage_operations" (organization_id, created_at DESC);
