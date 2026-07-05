INSERT INTO relay_providers (
  tenant_id,
  provider_id,
  adapter_type,
  base_url,
  capabilities,
  secret_reference,
  created_by
) VALUES (
  'tenant_demo',
  'local-openai-compatible',
  'openai-compatible',
  'http://127.0.0.1:11434',
  ARRAY['chat', 'stream', 'embeddings'],
  'secret://relay/local-openai-compatible',
  'development-seed'
) ON CONFLICT (tenant_id, provider_id) DO NOTHING;

INSERT INTO relay_routes (
  route_id,
  tenant_id,
  purpose,
  data_classifications,
  required_capabilities,
  max_cost_cents,
  provider_id,
  model,
  created_by
) VALUES (
  'route_local_chat',
  'tenant_demo',
  'chat',
  ARRAY['public', 'internal'],
  ARRAY['chat'],
  10,
  'local-openai-compatible',
  'local-demo',
  'development-seed'
) ON CONFLICT (route_id) DO NOTHING;
