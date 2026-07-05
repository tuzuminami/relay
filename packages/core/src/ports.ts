import type {
  AuditEvent,
  ChatCompletionResponse,
  ModelRoute,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderConfig,
  UsageRecord,
} from "./types.ts";

export interface RouteCatalog {
  listRoutesForTenant(tenantId: string): Promise<readonly ModelRoute[]>;
  getProvider(providerId: string): Promise<ProviderConfig | undefined>;
}

export interface SecretResolver {
  resolveSecret(reference: string): Promise<string>;
}

export interface ProviderAdapter {
  completeChat(request: ProviderChatRequest): Promise<ProviderChatResponse>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export interface UsageRepository {
  append(record: UsageRecord): Promise<void>;
  listForTenant(tenantId: string): Promise<readonly UsageRecord[]>;
}

export interface IdempotencyStore {
  get(tenantId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined>;
  put(tenantId: string, key: string, requestHash: string, response: ChatCompletionResponse): Promise<void>;
}

export interface CompletionRecorder {
  recordCompletion(input: {
    readonly tenantId: string;
    readonly idempotencyKey: string;
    readonly requestHash: string;
    readonly response: ChatCompletionResponse;
    readonly usage: UsageRecord;
    readonly audit: AuditEvent;
  }): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(prefix: string): string;
}
