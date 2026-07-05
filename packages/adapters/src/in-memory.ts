import { RelayError } from "../../core/src/errors.ts";
import type { AuditLog, Clock, CompletionRecorder, IdGenerator, IdempotencyStore, ProviderAdapter, RouteCatalog, SecretResolver, UsageRepository } from "../../core/src/ports.ts";
import type { AuditEvent, ChatCompletionResponse, ModelRoute, ProviderChatRequest, ProviderChatResponse, ProviderConfig, UsageRecord } from "../../core/src/types.ts";

export class FixedClock implements Clock {
  private readonly fixed: Date;

  constructor(fixed: Date = new Date("2026-01-01T00:00:00.000Z")) {
    this.fixed = fixed;
  }

  now(): Date {
    return new Date(this.fixed);
  }
}

export class SequentialIdGenerator implements IdGenerator {
  private nextValue = 1;

  next(prefix: string): string {
    const value = String(this.nextValue).padStart(6, "0");
    this.nextValue += 1;
    return `${prefix}_${value}`;
  }
}

export class InMemoryRelayStore implements RouteCatalog, AuditLog, IdempotencyStore, CompletionRecorder {
  readonly routes: ModelRoute[];
  readonly providers: ProviderConfig[];
  readonly auditEvents: AuditEvent[] = [];
  readonly usageRecords: UsageRecord[] = [];
  private readonly idempotency = new Map<string, { readonly requestHash: string; readonly response: ChatCompletionResponse }>();

  constructor(routes: readonly ModelRoute[], providers: readonly ProviderConfig[]) {
    this.routes = [...routes];
    this.providers = [...providers];
  }

  async listRoutesForTenant(tenantId: string): Promise<readonly ModelRoute[]> {
    return this.routes.filter((route) => route.tenantId === tenantId);
  }

  async getProvider(providerId: string): Promise<ProviderConfig | undefined> {
    return this.providers.find((provider) => provider.providerId === providerId);
  }

  async append(event: AuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }

  async appendUsage(record: UsageRecord): Promise<void> {
    this.usageRecords.push(record);
  }

  async get(tenantId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined> {
    return this.idempotency.get(`${tenantId}:${key}`);
  }

  async put(tenantId: string, key: string, requestHash: string, response: ChatCompletionResponse): Promise<void> {
    this.idempotency.set(`${tenantId}:${key}`, { requestHash, response });
  }

  async recordCompletion(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly response: ChatCompletionResponse;
    readonly usage: UsageRecord;
    readonly audit: AuditEvent;
  }): Promise<void> {
    const key = `${input.tenantId}:${input.idempotencyKey}`;
    if (this.idempotency.has(key)) {
      return;
    }
    this.idempotency.set(key, { requestHash: input.requestHash, response: input.response });
    this.usageRecords.push(input.usage);
    this.auditEvents.push(input.audit);
  }
}

export class InMemoryUsageRepository implements UsageRepository {
  private readonly store: InMemoryRelayStore;

  constructor(store: InMemoryRelayStore) {
    this.store = store;
  }

  async append(record: UsageRecord): Promise<void> {
    await this.store.appendUsage(record);
  }

  async listForTenant(tenantId: string): Promise<readonly UsageRecord[]> {
    return this.store.usageRecords.filter((record) => record.tenantId === tenantId);
  }
}

export class StaticSecretResolver implements SecretResolver {
  private readonly secrets: ReadonlyMap<string, string>;

  constructor(secrets: ReadonlyMap<string, string>) {
    this.secrets = secrets;
  }

  async resolveSecret(reference: string): Promise<string> {
    const secret = this.secrets.get(reference);
    if (secret === undefined) {
      throw new RelayError("CONFIGURATION_INVALID", "Configured secret reference is unavailable.", 503, [], true);
    }
    return secret;
  }
}

export class StubProviderAdapter implements ProviderAdapter {
  calls = 0;

  async completeChat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    this.calls += 1;
    return {
      message: { role: "assistant", content: `stub:${request.model}:${request.messages.length}` },
      usage: {
        inputTokens: request.messages.reduce((sum, message) => sum + message.content.length, 0),
        outputTokens: 12,
        estimatedCostCents: 1,
      },
      terminalReason: "stop",
      latencyMs: 4,
    };
  }
}
