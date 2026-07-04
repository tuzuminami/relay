import { validationFailed } from "./errors.ts";
import type { Capability, ChatCompletionRequest, ChatMessage, DataClassification, ProviderValidationRequest } from "./types.ts";

const roles = new Set(["system", "user", "assistant", "tool"]);
const classifications = new Set(["public", "internal", "confidential", "restricted"]);
const capabilities = new Set(["chat", "stream", "embeddings", "tools", "json_mode", "vision"]);

export function parseChatCompletionRequest(input: unknown): ChatCompletionRequest {
  const record = asRecord(input, "body");
  const details: string[] = [];
  const model = readString(record, "model", details);
  const purpose = readString(record, "purpose", details);
  const dataClassification = readEnum<DataClassification>(record, "dataClassification", classifications, details);
  const messages = readMessages(record.messages, details);
  const requiredCapabilities = readEnumArray<Capability>(record.requiredCapabilities, "requiredCapabilities", capabilities, details);
  const maxCostCents = readInteger(record, "maxCostCents", details);
  const toolsStarted = typeof record.toolsStarted === "boolean" ? record.toolsStarted : undefined;

  if (!requiredCapabilities.includes("chat")) {
    details.push("requiredCapabilities must include chat");
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }

  return {
    model,
    purpose,
    dataClassification,
    messages,
    requiredCapabilities,
    maxCostCents,
    ...(toolsStarted === undefined ? {} : { toolsStarted }),
  };
}

export function parseRouteQuery(input: URLSearchParams): Pick<
  ChatCompletionRequest,
  "purpose" | "dataClassification" | "requiredCapabilities" | "maxCostCents"
> {
  const details: string[] = [];
  const purpose = input.get("purpose") ?? "";
  if (purpose.length === 0) {
    details.push("purpose is required");
  }
  const dataClassificationRaw = input.get("dataClassification") ?? "";
  if (!classifications.has(dataClassificationRaw)) {
    details.push("dataClassification is invalid");
  }
  const requiredCapabilities = input.getAll("capability");
  if (requiredCapabilities.length === 0) {
    details.push("at least one capability is required");
  }
  for (const capability of requiredCapabilities) {
    if (!capabilities.has(capability)) {
      details.push(`capability is invalid: ${capability}`);
    }
  }
  const maxCostCents = Number.parseInt(input.get("maxCostCents") ?? "", 10);
  if (!Number.isInteger(maxCostCents) || maxCostCents < 0) {
    details.push("maxCostCents must be a non-negative integer");
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }
  return {
    purpose,
    dataClassification: dataClassificationRaw as DataClassification,
    requiredCapabilities: requiredCapabilities as Capability[],
    maxCostCents,
  };
}

export function parseProviderValidationRequest(input: unknown): ProviderValidationRequest {
  const record = asRecord(input, "body");
  const details: string[] = [];
  const providerId = readString(record, "providerId", details);
  const adapterType = readEnum<"openai-compatible">(record, "adapterType", new Set(["openai-compatible"]), details);
  const baseUrl = readString(record, "baseUrl", details);
  const secretReference = readString(record, "secretReference", details);
  const providerCapabilities = readEnumArray<Capability>(record.capabilities, "capabilities", capabilities, details);

  if (!secretReference.startsWith("secret://")) {
    details.push("secretReference must use the secret:// scheme");
  }
  if (details.length > 0) {
    throw validationFailed(details);
  }

  return {
    providerId,
    adapterType,
    baseUrl,
    secretReference,
    capabilities: providerCapabilities,
  };
}

function asRecord(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw validationFailed([`${label} must be an object`]);
  }
  return input as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, details: string[]): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    details.push(`${key} must be a non-empty string`);
    return "";
  }
  return value;
}

function readInteger(record: Record<string, unknown>, key: string, details: string[]): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    details.push(`${key} must be a non-negative integer`);
    return 0;
  }
  return value;
}

function readEnum<T extends string>(
  record: Record<string, unknown>,
  key: string,
  allowed: ReadonlySet<string>,
  details: string[],
): T {
  const value = record[key];
  if (typeof value !== "string" || !allowed.has(value)) {
    details.push(`${key} is invalid`);
    return "" as T;
  }
  return value as T;
}

function readEnumArray<T extends string>(
  value: unknown,
  key: string,
  allowed: ReadonlySet<string>,
  details: string[],
): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) {
    details.push(`${key} must be a non-empty array`);
    return [];
  }
  const values: T[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      details.push(`${key} contains an invalid value`);
    } else {
      values.push(item as T);
    }
  }
  return values;
}

function readMessages(value: unknown, details: string[]): readonly ChatMessage[] {
  if (!Array.isArray(value) || value.length === 0) {
    details.push("messages must be a non-empty array");
    return [];
  }
  const messages: ChatMessage[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      details.push("message must be an object");
      continue;
    }
    const record = item as Record<string, unknown>;
    const role = record.role;
    const content = record.content;
    if (typeof role !== "string" || !roles.has(role)) {
      details.push("message.role is invalid");
      continue;
    }
    if (typeof content !== "string" || content.length === 0) {
      details.push("message.content must be a non-empty string");
      continue;
    }
    messages.push({ role: role as ChatMessage["role"], content });
  }
  return messages;
}
