CREATE TABLE IF NOT EXISTS relay_providers (
  provider_id text PRIMARY KEY,
  adapter_type text NOT NULL,
  base_url text NOT NULL,
  capabilities text[] NOT NULL,
  secret_reference text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1
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
    FOREIGN KEY (provider_id) REFERENCES relay_providers(provider_id)
);

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
  response_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, idempotency_key)
);
