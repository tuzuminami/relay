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
  private readonly idempotency = new Map<string, {
    readonly requestHash: string;
    readonly response?: ChatCompletionResponse;
    readonly status: "in_progress" | "completed" | "failed";
  }>();

  constructor(routes: readonly ModelRoute[], providers: readonly ProviderConfig[]) {
    this.routes = [...routes];
    this.providers = [...providers];
  }

  async listRoutesForTenant(tenantId: string): Promise<readonly ModelRoute[]> {
    return this.routes.filter((route) => route.tenantId === tenantId);
  }

  async getProvider(tenantId: string, providerId: string): Promise<ProviderConfig | undefined> {
    return this.providers.find((provider) => provider.tenantId === tenantId && provider.providerId === providerId);
  }

  async append(event: AuditEvent): Promise<void> {
    this.auditEvents.push(event);
  }

  async appendUsage(record: UsageRecord): Promise<void> {
    this.usageRecords.push(record);
  }

  async get(tenantId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined> {
    const record = await this.lookup(tenantId, key);
    if (record === undefined || record.status !== "completed") {
      return undefined;
    }
    return { requestHash: record.requestHash, response: record.response };
  }

  async lookup(tenantId: string, key: string) {
    const record = this.idempotency.get(`${tenantId}:${key}`);
    if (record === undefined) {
      return undefined;
    }
    if (record.status === "completed" && record.response !== undefined) {
      return { status: "completed" as const, requestHash: record.requestHash, response: record.response };
    }
    if (record.status === "failed") {
      return { status: "failed" as const, requestHash: record.requestHash };
    }
    return { status: "in_progress" as const, requestHash: record.requestHash };
  }

  async reserve(tenantId: string, key: string, requestHash: string) {
    const idempotencyKey = `${tenantId}:${key}`;
    const record = this.idempotency.get(idempotencyKey);
    if (record === undefined) {
      this.idempotency.set(idempotencyKey, { requestHash, status: "in_progress" });
      return { status: "reserved" as const };
    }
    if (record.requestHash !== requestHash) {
      return { status: "conflict" as const, requestHash: record.requestHash };
    }
    if (record.status === "completed" && record.response !== undefined) {
      return { status: "completed" as const, requestHash: record.requestHash, response: record.response };
    }
    if (record.status === "failed") {
      return { status: "failed" as const, requestHash: record.requestHash };
    }
    return { status: "in_progress" as const, requestHash: record.requestHash };
  }

  async fail(tenantId: string, key: string, requestHash: string): Promise<void> {
    const idempotencyKey = `${tenantId}:${key}`;
    const record = this.idempotency.get(idempotencyKey);
    if (record !== undefined && record.requestHash === requestHash && record.status === "in_progress") {
      this.idempotency.set(idempotencyKey, { requestHash, status: "failed" });
    }
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
    const existing = this.idempotency.get(key);
    if (existing === undefined || existing.requestHash !== input.requestHash || existing.status !== "in_progress") {
      throw new RelayError("IDEMPOTENCY_CONFLICT", "Idempotency key was already recorded.", 409);
    }
    this.idempotency.set(key, { requestHash: input.requestHash, response: input.response, status: "completed" });
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
