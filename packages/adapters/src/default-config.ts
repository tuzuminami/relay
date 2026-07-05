import type { ModelRoute, ProviderConfig } from "../../core/src/types.ts";

export function defaultProviderConfig(): ProviderConfig {
  return {
    tenantId: "tenant_demo",
    providerId: "local-openai-compatible",
    adapterType: "openai-compatible",
    baseUrl: process.env.RELAY_PROVIDER_BASE_URL ?? "http://127.0.0.1:11434",
    capabilities: ["chat", "stream", "embeddings"],
    secretReference: "secret://relay/local-openai-compatible",
    enabled: true,
  };
}

export function defaultRoute(): ModelRoute {
  return {
    routeId: "route_local_chat",
    tenantId: "tenant_demo",
    purpose: "chat",
    allowedDataClassifications: ["public", "internal"],
    requiredCapabilities: ["chat"],
    maxCostCents: 10,
    providerId: "local-openai-compatible",
    model: process.env.RELAY_PROVIDER_MODEL ?? "local-demo",
    enabled: true,
  };
}
