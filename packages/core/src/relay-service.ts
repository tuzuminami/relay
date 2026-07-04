import { RelayError, validationFailed } from "./errors.ts";
import type { AuditLog, Clock, IdGenerator, IdempotencyStore, ProviderAdapter, RouteCatalog, SecretResolver, UsageRepository } from "./ports.ts";
import { assertRouteAllowed, resolveRoute } from "./route-policy.ts";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderConfig, ProviderValidationRequest, ProviderValidationResult, RequestContext, RouteResolution, UsageRecord } from "./types.ts";

export interface RelayServicePorts {
  readonly routes: RouteCatalog;
  readonly secrets: SecretResolver;
  readonly provider: ProviderAdapter;
  readonly audit: AuditLog;
  readonly usage: UsageRepository;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export class RelayService {
  private readonly ports: RelayServicePorts;

  constructor(ports: RelayServicePorts) {
    this.ports = ports;
  }

  async resolve(ctx: RequestContext, request: Pick<ChatCompletionRequest, "purpose" | "dataClassification" | "requiredCapabilities" | "maxCostCents">): Promise<RouteResolution> {
    assertTenantScope(ctx);
    const routes = await this.ports.routes.listRoutesForTenant(ctx.auth.tenantId);
    const providers = await this.providerMap(routes);
    return resolveRoute(ctx.auth.tenantId, request, routes, providers);
  }

  async completeChat(ctx: RequestContext, request: ChatCompletionRequest, idempotencyKey: string): Promise<ChatCompletionResponse> {
    assertTenantScope(ctx);
    if (idempotencyKey.length === 0) {
      throw validationFailed(["Idempotency-Key header is required"]);
    }

    const previous = await this.ports.idempotency.get(ctx.auth.tenantId, idempotencyKey);
    if (previous !== undefined) {
      return previous;
    }

    const resolution = await this.resolve(ctx, request);
    assertRouteAllowed(resolution);
    const secretValue = await this.ports.secrets.resolveSecret(resolution.provider.secretReference);
    const startedAt = this.ports.clock.now().getTime();
    const providerResponse = await this.ports.provider.completeChat({
      provider: resolution.provider,
      secretValue,
      model: resolution.route.model,
      messages: request.messages,
      correlationId: ctx.correlationId,
    });
    const latencyMs = Math.max(providerResponse.latencyMs, this.ports.clock.now().getTime() - startedAt);
    const response: ChatCompletionResponse = {
      id: this.ports.ids.next("chat"),
      model: resolution.route.model,
      providerId: resolution.provider.providerId,
      routeId: resolution.route.routeId,
      message: providerResponse.message,
      usage: providerResponse.usage,
      terminalReason: providerResponse.terminalReason,
    };

    await this.ports.usage.append({
      id: this.ports.ids.next("usage"),
      tenantId: ctx.auth.tenantId,
      requestId: ctx.requestId,
      routeId: resolution.route.routeId,
      providerId: resolution.provider.providerId,
      model: resolution.route.model,
      usage: providerResponse.usage,
      latencyMs,
      terminalReason: providerResponse.terminalReason,
      correlationId: ctx.correlationId,
      createdAt: this.ports.clock.now(),
    });
    await this.ports.audit.append({
      id: this.ports.ids.next("audit"),
      tenantId: ctx.auth.tenantId,
      actorId: ctx.auth.actorId,
      action: "relay.chat.complete",
      resourceType: "chat_completion",
      resourceId: response.id,
      reasonCode: "CHAT_COMPLETION_ROUTED",
      correlationId: ctx.correlationId,
      metadata: {
        routeId: response.routeId,
        providerId: response.providerId,
        model: response.model,
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        estimatedCostCents: response.usage.estimatedCostCents,
      },
      createdAt: this.ports.clock.now(),
    });
    await this.ports.idempotency.put(ctx.auth.tenantId, idempotencyKey, response);
    return response;
  }

  async listUsage(ctx: RequestContext): Promise<readonly UsageRecord[]> {
    assertTenantScope(ctx);
    return this.ports.usage.listForTenant(ctx.auth.tenantId);
  }

  async validateProvider(ctx: RequestContext, request: ProviderValidationRequest): Promise<ProviderValidationResult> {
    assertTenantScope(ctx);
    const reasons: string[] = [];
    if (request.capabilities.length === 0) {
      reasons.push("CAPABILITIES_REQUIRED");
    }
    if (!request.secretReference.startsWith("secret://")) {
      reasons.push("SECRET_REFERENCE_REQUIRED");
    }
    try {
      new URL(request.baseUrl);
    } catch {
      reasons.push("BASE_URL_INVALID");
    }
    await this.ports.audit.append({
      id: this.ports.ids.next("audit"),
      tenantId: ctx.auth.tenantId,
      actorId: ctx.auth.actorId,
      action: "relay.provider.validate",
      resourceType: "provider_config",
      resourceId: request.providerId,
      reasonCode: reasons.length === 0 ? "PROVIDER_CONFIG_VALID" : "PROVIDER_CONFIG_INVALID",
      correlationId: ctx.correlationId,
      metadata: {
        providerId: request.providerId,
        adapterType: request.adapterType,
        capabilityCount: request.capabilities.length,
      },
      createdAt: this.ports.clock.now(),
    });
    return {
      valid: reasons.length === 0,
      reasonCodes: reasons.length === 0 ? ["PROVIDER_CONFIG_VALID"] : reasons,
      providerId: request.providerId,
      capabilities: request.capabilities,
    };
  }

  private async providerMap(routes: readonly { readonly providerId: string }[]): Promise<ReadonlyMap<string, ProviderConfig>> {
    const providers = new Map<string, ProviderConfig>();
    for (const route of routes) {
      if (!providers.has(route.providerId)) {
        const provider = await this.ports.routes.getProvider(route.providerId);
        if (provider !== undefined) {
          providers.set(provider.providerId, provider);
        }
      }
    }
    return providers;
  }
}

function assertTenantScope(ctx: RequestContext): void {
  if (!ctx.auth.scopes.includes("relay:invoke")) {
    throw new RelayError("TENANT_SCOPE_DENIED", "Request cannot access this resource.", 403);
  }
}
