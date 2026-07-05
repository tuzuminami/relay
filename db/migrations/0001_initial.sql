CREATE TABLE IF NOT EXISTS relay_providers (
  tenant_id text NOT NULL DEFAULT 'tenant_demo',
  provider_id text NOT NULL,
  adapter_type text NOT NULL,
  base_url text NOT NULL,
  capabilities text[] NOT NULL,
  secret_reference text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, provider_id)
);

CREATE TABLE IF NOT EXISTS relay_routes (
  route_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  purpose text NOT NULL,
  data_classifications text[] NOT NULL,
  required_capabilities text[] NOT NULL,
  max_cost_cents integer NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  CONSTRAINT relay_routes_provider_fk
    FOREIGN KEY (tenant_id, provider_id) REFERENCES relay_providers(tenant_id, provider_id)
);

ALTER TABLE relay_providers
  ADD COLUMN IF NOT EXISTS tenant_id text NOT NULL DEFAULT 'tenant_demo';

ALTER TABLE relay_routes
  DROP CONSTRAINT IF EXISTS relay_routes_provider_fk;

ALTER TABLE relay_providers
  DROP CONSTRAINT IF EXISTS relay_providers_pkey;

ALTER TABLE relay_providers
  ADD CONSTRAINT relay_providers_pkey PRIMARY KEY (tenant_id, provider_id);

CREATE UNIQUE INDEX IF NOT EXISTS relay_providers_tenant_provider_uidx
  ON relay_providers (tenant_id, provider_id);

ALTER TABLE relay_routes
  ADD CONSTRAINT relay_routes_provider_fk
    FOREIGN KEY (tenant_id, provider_id) REFERENCES relay_providers(tenant_id, provider_id);

CREATE TABLE IF NOT EXISTS relay_audit_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  reason_code text NOT NULL,
  correlation_id text NOT NULL,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_outbox_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);

CREATE TABLE IF NOT EXISTS relay_usage_records (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  request_id text NOT NULL,
  route_id text NOT NULL,
  provider_id text NOT NULL,
  model text NOT NULL,
  input_tokens integer NOT NULL,
  output_tokens integer NOT NULL,
  estimated_cost_cents integer NOT NULL,
  latency_ms integer NOT NULL,
  terminal_reason text NOT NULL,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS relay_idempotency_records (
  tenant_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress',
  response_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  CONSTRAINT relay_idempotency_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed')),
  PRIMARY KEY (tenant_id, idempotency_key)
);

ALTER TABLE relay_idempotency_records
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'completed';

ALTER TABLE relay_idempotency_records
  ALTER COLUMN status SET DEFAULT 'in_progress';

ALTER TABLE relay_idempotency_records
  ALTER COLUMN response_json DROP NOT NULL;

ALTER TABLE relay_idempotency_records
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE relay_idempotency_records
  DROP CONSTRAINT IF EXISTS relay_idempotency_status_check;

ALTER TABLE relay_idempotency_records
  ADD CONSTRAINT relay_idempotency_status_check
    CHECK (status IN ('in_progress', 'completed', 'failed'));
