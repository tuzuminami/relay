import { RelayError } from "../../core/src/errors.ts";
import type { ProviderAdapter, SecretResolver } from "../../core/src/ports.ts";
import type { ChatMessage, ProviderChatRequest, ProviderChatResponse } from "../../core/src/types.ts";

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class OpenAiCompatibleHttpAdapter implements ProviderAdapter {
  private readonly fetchFn: FetchLike;
  private readonly secretResolver: SecretResolver;
  private readonly timeoutMs: number;

  constructor(options: { readonly fetchFn?: FetchLike; readonly secretResolver: SecretResolver; readonly timeoutMs?: number }) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.secretResolver = options.secretResolver;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async completeChat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      const secretValue = await this.secretResolver.resolveSecret(request.provider.secretReference);
      response = await this.fetchFn(`${request.provider.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secretValue}`,
          "content-type": "application/json",
          "x-correlation-id": request.correlationId,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
        }),
      });
    } catch (error) {
      if (error instanceof RelayError) {
        throw error;
      }
      throw providerUnavailable(error);
    } finally {
      clearTimeout(timeout);
    }

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
  }
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
