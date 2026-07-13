export type Capability = "chat" | "stream" | "embeddings" | "tools" | "json_mode" | "vision";
export type DataClassification = "public" | "internal" | "confidential" | "restricted";
export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface AuthContext {
  readonly actorId: string;
  readonly tenantId: string;
  readonly scopes: readonly string[];
  readonly authAdapter: "development" | "test" | "production";
}

export interface RequestContext {
  readonly auth: AuthContext;
  readonly requestId: string;
  readonly correlationId: string;
  readonly now: Date;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string;
}

export interface ChatCompletionRequest {
  readonly model: string;
  readonly purpose: string;
  readonly dataClassification: DataClassification;
  readonly messages: readonly ChatMessage[];
  readonly requiredCapabilities: readonly Capability[];
  readonly maxCostCents: number;
  readonly toolsStarted?: boolean;
}

export interface VeilEnforcementContext {
  readonly token: string;
}

export interface VerifiedVeilDecision {
  readonly decisionId: string;
  readonly tenantId: string;
  readonly requestedAction: "model_call" | "tool_call";
  readonly inputHash: string;
  readonly policyHash: string;
  readonly expiresAt: Date;
}

export interface ChatCompletionResponse {
  readonly id: string;
  readonly model: string;
  readonly providerId: string;
  readonly routeId: string;
  readonly message: ChatMessage;
  readonly usage: TokenUsage;
  readonly terminalReason: "stop" | "length" | "interrupted";
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly estimatedCostCents: number;
}

export interface ProviderConfig {
  readonly tenantId: string;
  readonly providerId: string;
  readonly adapterType: "openai-compatible";
  readonly baseUrl: string;
  readonly capabilities: readonly Capability[];
  readonly secretReference: string;
  readonly enabled: boolean;
}

export interface ModelRoute {
  readonly routeId: string;
  readonly tenantId: string;
  readonly purpose: string;
  readonly allowedDataClassifications: readonly DataClassification[];
  readonly requiredCapabilities: readonly Capability[];
  readonly maxCostCents: number;
  readonly providerId: string;
  readonly model: string;
  readonly enabled: boolean;
}

export interface RouteResolution {
  readonly allowed: boolean;
  readonly reasonCodes: readonly string[];
  readonly route?: ModelRoute;
  readonly provider?: ProviderConfig;
}

export interface ProviderChatRequest {
  readonly provider: ProviderConfig;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly correlationId: string;
}

export interface ProviderChatResponse {
  readonly message: ChatMessage;
  readonly usage: TokenUsage;
  readonly terminalReason: "stop" | "length" | "interrupted";
  readonly latencyMs: number;
}

export interface UsageRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly requestId: string;
  readonly routeId: string;
  readonly providerId: string;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
  readonly terminalReason: string;
  readonly correlationId: string;
  readonly createdAt: Date;
}

export interface ProviderValidationRequest {
  readonly providerId: string;
  readonly adapterType: "openai-compatible";
  readonly baseUrl: string;
  readonly capabilities: readonly Capability[];
  readonly secretReference: string;
}

export interface ProviderValidationResult {
  readonly valid: boolean;
  readonly reasonCodes: readonly string[];
  readonly providerId: string;
  readonly capabilities: readonly Capability[];
}

export interface AuditEvent {
  readonly id: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reasonCode: string;
  readonly correlationId: string;
  readonly metadata: Record<string, string | number | boolean>;
  readonly createdAt: Date;
}
