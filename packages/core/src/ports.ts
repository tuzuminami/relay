import type {
  AuditEvent,
  ChatCompletionResponse,
  ModelRoute,
  ProviderChatRequest,
  ProviderChatResponse,
  ProviderConfig,
  UsageRecord,
  VerifiedVeilDecision,
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

export interface VeilDecisionClaim {
  readonly tenantId: string;
  readonly decisionId: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

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

export interface VeilDecisionVerifier {
  verify(input: {
    readonly token: string;
    readonly tenantId: string;
    readonly requestedAction: "model_call" | "tool_call";
    readonly inputHash: string;
    readonly now: Date;
  }): Promise<VerifiedVeilDecision>;
}

export interface VeilDecisionReplayStore {
  claim(input: VeilDecisionClaim): Promise<boolean>;
}

export interface AuditLog {
  append(event: AuditEvent): Promise<void>;
}

export interface UsageRepository {
  append(record: UsageRecord): Promise<void>;
  listForTenant(tenantId: string): Promise<readonly UsageRecord[]>;
}

export interface IdempotencyStore {
  lookup(tenantId: string, actorId: string, key: string): Promise<IdempotencyRecord | undefined>;
  reserve(tenantId: string, actorId: string, key: string, requestHash: string): Promise<IdempotencyReservation>;
  reserveWithVeilDecision?(input: {
    readonly tenantId: string;
    readonly actorId: string;
    readonly key: string;
    readonly requestHash: string;
    readonly decision: VeilDecisionClaim;
  }): Promise<IdempotencyReservation | { readonly status: "replayed" }>;
  get(tenantId: string, actorId: string, key: string): Promise<{ readonly requestHash: string; readonly response: ChatCompletionResponse } | undefined>;
  cancel(tenantId: string, actorId: string, key: string, requestHash: string): Promise<void>;
  fail(tenantId: string, actorId: string, key: string, requestHash: string): Promise<void>;
}

export interface CompletionRecorder {
  recordCompletion(input: {
    readonly tenantId: string;
    readonly actorId: string;
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
