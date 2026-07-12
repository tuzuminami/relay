import { RelayError } from "../../core/src/errors.ts";
import type { ProviderAdapter, SecretResolver } from "../../core/src/ports.ts";
import { canonicalProviderOrigin, providerAddressRejectionReasonsForAddresses, providerBaseUrlRejectionReasons, systemProviderAddressResolver, type ProviderAddressResolver, type ProviderEgressPolicy } from "../../core/src/provider-url.ts";
import type { ChatMessage, ProviderChatRequest, ProviderChatResponse } from "../../core/src/types.ts";
import { Agent, fetch as undiciFetch, interceptors, type Dispatcher } from "undici";

type ProviderResponse = { readonly ok: boolean; readonly status: number; json(): Promise<unknown> };
type FetchLike = (input: string, init: NonNullable<Parameters<typeof undiciFetch>[1]>) => Promise<ProviderResponse>;
type DispatcherFactory = (hostname: string, addresses: readonly string[]) => Dispatcher;

export class OpenAiCompatibleHttpAdapter implements ProviderAdapter {
  private readonly fetchFn: FetchLike;
  private readonly secretResolver: SecretResolver;
  private readonly timeoutMs: number;
  private readonly egressPolicy: ProviderEgressPolicy;
  private readonly addressResolver: ProviderAddressResolver;
  private readonly dispatcherFactory: DispatcherFactory;

  constructor(options: { readonly fetchFn?: FetchLike; readonly secretResolver: SecretResolver; readonly timeoutMs?: number; readonly egressPolicy: ProviderEgressPolicy; readonly addressResolver?: ProviderAddressResolver; readonly dispatcherFactory?: DispatcherFactory }) {
    if (options.egressPolicy === undefined) {
      throw new RelayError("CONFIGURATION_INVALID", "Provider egress policy is required.", 503);
    }
    this.fetchFn = options.fetchFn ?? ((input, init) => undiciFetch(input, init));
    this.secretResolver = options.secretResolver;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.egressPolicy = options.egressPolicy;
    this.addressResolver = options.addressResolver ?? systemProviderAddressResolver;
    this.dispatcherFactory = options.dispatcherFactory ?? createPinnedProviderDispatcher;
  }

  async completeChat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let dispatcher: Dispatcher | undefined;
    let response: ProviderResponse;
    try {
      const rejectionReasons = providerBaseUrlRejectionReasons(request.provider.baseUrl, this.egressPolicy);
      if (rejectionReasons.length > 0) {
        throw new RelayError("CONFIGURATION_INVALID", "Provider base URL is not permitted.", 503, rejectionReasons);
      }
      const addresses = await resolveProviderAddresses(request.provider.baseUrl, this.addressResolver);
      const addressRejectionReasons = providerAddressRejectionReasonsForAddresses(addresses);
      if (addressRejectionReasons.length > 0) {
        throw new RelayError("CONFIGURATION_INVALID", "Provider base URL is not permitted.", 503, addressRejectionReasons);
      }
      const secretValue = await this.secretResolver.resolveSecret({
        tenantId: request.provider.tenantId,
        reference: request.provider.secretReference,
        allowedOrigin: canonicalProviderOrigin(request.provider.baseUrl),
      });
      dispatcher = this.dispatcherFactory(new URL(request.provider.baseUrl).hostname, addresses);
      response = await this.fetchFn(`${request.provider.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${secretValue}`,
          "content-type": "application/json",
          "x-correlation-id": request.correlationId,
        },
        signal: controller.signal,
        dispatcher,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
        }),
      });

      if (!response.ok) {
        throw new RelayError("DEPENDENCY_UNAVAILABLE", "Provider request failed safely.", 503, [`provider_status:${response.status}`], true);
      }

      const payload = asRecord(await response.json());
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const firstChoice = choices[0];
      if (typeof firstChoice !== "object" || firstChoice === null) {
        throw new RelayError("DEPENDENCY_UNAVAILABLE", "Provider response was invalid.", 503, [], true);
      }
      const choice = firstChoice as Record<string, unknown>;
      const message = asChatMessage(choice.message);
      const usage = asRecord(payload.usage ?? {});
      return {
        message,
        usage: {
          inputTokens: readNumber(usage.prompt_tokens),
          outputTokens: readNumber(usage.completion_tokens),
          estimatedCostCents: 0,
        },
        terminalReason: choice.finish_reason === "length" ? "length" : "stop",
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      throw providerUnavailable(error);
    } finally {
      clearTimeout(timeout);
      await dispatcher?.close();
    }

  }
}

export function createPinnedProviderDispatcher(hostname: string, addresses: readonly string[]): Dispatcher {
  return new Agent().compose(interceptors.dns({
    lookup: (_origin, _options, callback) => callback(null, addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4, ttl: 0 }))),
  }));
}

async function resolveProviderAddresses(value: string, resolver: ProviderAddressResolver): Promise<readonly string[]> {
  const hostname = new URL(value).hostname;
  return resolver.resolve(hostname);
}

function providerUnavailable(error: unknown): RelayError {
  if (error instanceof Error && error.name === "AbortError") {
    return new RelayError("DEPENDENCY_UNAVAILABLE", "Provider request timed out safely.", 503, ["provider_timeout"], true);
  }
  return new RelayError("DEPENDENCY_UNAVAILABLE", "Provider request failed safely.", 503, [], true);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new RelayError("DEPENDENCY_UNAVAILABLE", "Provider response was invalid.", 503, [], true);
  }
  return input as Record<string, unknown>;
}

function asChatMessage(input: unknown): ChatMessage {
  const record = asRecord(input);
  if (record.role !== "assistant" || typeof record.content !== "string") {
    throw new RelayError("DEPENDENCY_UNAVAILABLE", "Provider response message was invalid.", 503, [], true);
  }
  return { role: "assistant", content: record.content };
}

function readNumber(input: unknown): number {
  return typeof input === "number" && Number.isFinite(input) ? Math.trunc(input) : 0;
}
