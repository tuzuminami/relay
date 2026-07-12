import type {
  AuditEvent,
  ChatCompletionResponse,
  ModelRoute,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderConfig,
  UsageRecord,
} from "./types.ts";

export type IdempotencyReservation =
  | { readonly status: "reserved" }
  | { readonly status: "in_progress"; readonly requestHash: string }
  | { readonly status: "completed"; readonly requestHash: string; readonly response: ChatCompletionResponse }
  | { readonly status: "failed"; readonly requestHash: string }
  | { readonly status: "conflict"; readonly requestHash: string };

export type IdempotencyRecord =
  | { readonly status: "in_progress"; readonly requestHash: string }
  | { readonly status: "completed"; readonly requestHash: string; readonly response: ChatCompletionResponse }
  | { readonly status: "failed"; readonly requestHash: string };

export interface RouteCatalog {
  listRoutesForTenant(tenantId: string): Promise<readonly ModelRoute[]>;
  getProvider(tenantId: string, providerId: string): Promise<ProviderConfig | undefined>;
}

export interface SecretResolver {
  resolveSecret(binding: SecretBinding): Promise<string>;
}

export interface SecretBinding {
  readonly tenantId: string;
  readonly reference: string;
  readonly allowedOrigin: string;
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
  lookup(tenantId: string, key: string): Promise<IdempotencyRecord | undefined>;
  reserve(tenantId: string, key: string, requestHash: string): Promise<IdempotencyReservation>;
  get(tenantId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined>;
  fail(tenantId: string, key: string, requestHash: string): Promise<void>;
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
