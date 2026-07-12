import { createHash } from "node:crypto";
import { RelayError, validationFailed } from "./errors.ts";
import type { AuditLog, Clock, CompletionRecorder, IdGenerator, IdempotencyStore, ProviderAdapter, RouteCatalog, UsageRepository } from "./ports.ts";
import { providerAddressRejectionReasons, providerBaseUrlRejectionReasons, systemProviderAddressResolver, type ProviderAddressResolver, type ProviderEgressPolicy } from "./provider-url.ts";
import { assertRouteAllowed, resolveRoute } from "./route-policy.ts";
import type { ChatCompletionRequest, ChatCompletionResponse, ProviderConfig, ProviderValidationRequest, ProviderValidationResult, RequestContext, RouteResolution, UsageRecord } from "./types.ts";

export interface RelayServicePorts {
  readonly routes: RouteCatalog;
  readonly provider: ProviderAdapter;
  readonly audit: AuditLog;
  readonly usage: UsageRepository;
  readonly idempotency: IdempotencyStore;
  readonly completions: CompletionRecorder;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly providerEgressPolicy?: ProviderEgressPolicy;
  readonly providerAddressResolver?: ProviderAddressResolver;
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

    const requestHash = hashRequest(request);
    const previous = await this.ports.idempotency.lookup(ctx.auth.tenantId, idempotencyKey);
    const previousResponse = responseFromIdempotencyState(previous, requestHash);
    if (previousResponse !== undefined) {
      return previousResponse;
    }

    const resolution = await this.resolve(ctx, request);
    assertRouteAllowed(resolution);
    const reservation = await this.ports.idempotency.reserve(ctx.auth.tenantId, idempotencyKey, requestHash);
    switch (reservation.status) {
      case "completed":
        return reservation.response;
      case "conflict":
        throw new RelayError(
          "IDEMPOTENCY_CONFLICT",
          "Idempotency key was already used with a different request.",
          409,
        );
      case "in_progress":
        throw new RelayError(
          "IDEMPOTENCY_IN_PROGRESS",
          "Idempotency key is already processing this request.",
          409,
        );
      case "failed":
        throw new RelayError(
          "IDEMPOTENCY_FAILED",
          "Idempotency key is associated with a failed prior attempt.",
          409,
        );
      case "reserved":
        break;
    }

    try {
      const startedAt = this.ports.clock.now().getTime();
      const providerResponse = await this.ports.provider.completeChat({
        provider: resolution.provider,
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

      const usage: UsageRecord = {
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
      };
      const audit = {
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
      };
      await this.ports.completions.recordCompletion({
        tenantId: ctx.auth.tenantId,
        idempotencyKey,
        requestHash,
        response,
        usage,
        audit,
      });
      return response;
    } catch (error) {
      try {
        await this.ports.idempotency.fail(ctx.auth.tenantId, idempotencyKey, requestHash);
      } catch {
        // Preserve the original provider or persistence failure for callers.
      }
      throw error;
    }
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
    reasons.push(...providerBaseUrlRejectionReasons(request.baseUrl, this.ports.providerEgressPolicy ?? { production: false, allowedOrigins: [] }));
    if (reasons.length === 0) {
      reasons.push(...await providerAddressRejectionReasons(request.baseUrl, this.ports.providerAddressResolver ?? systemProviderAddressResolver));
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

  private async providerMap(routes: readonly { readonly tenantId: string; readonly providerId: string }[]): Promise<ReadonlyMap<string, ProviderConfig>> {
    const providers = new Map<string, ProviderConfig>();
    for (const route of routes) {
      if (!providers.has(route.providerId)) {
        const provider = await this.ports.routes.getProvider(route.tenantId, route.providerId);
        if (provider !== undefined) {
          providers.set(provider.providerId, provider);
        }
      }
    }
    return providers;
  }
}

function responseFromIdempotencyState(
  state: Awaited<ReturnType<IdempotencyStore["lookup"]>>,
  requestHash: string,
): ChatCompletionResponse | undefined {
  if (state === undefined) {
    return undefined;
  }
  if (state.requestHash !== requestHash) {
    throw new RelayError(
      "IDEMPOTENCY_CONFLICT",
      "Idempotency key was already used with a different request.",
      409,
    );
  }
  if (state.status === "completed") {
    return state.response;
  }
  if (state.status === "failed") {
    throw new RelayError(
      "IDEMPOTENCY_FAILED",
      "Idempotency key is associated with a failed prior attempt.",
      409,
    );
  }
  throw new RelayError(
    "IDEMPOTENCY_IN_PROGRESS",
    "Idempotency key is already processing this request.",
    409,
  );
}

function hashRequest(request: ChatCompletionRequest): string {
  return createHash("sha256").update(stableStringify(request)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertTenantScope(ctx: RequestContext): void {
  if (!ctx.auth.scopes.includes("relay:invoke")) {
    throw new RelayError("TENANT_SCOPE_DENIED", "Request cannot access this resource.", 403);
  }
}
