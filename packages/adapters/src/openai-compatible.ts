import { RelayError } from "../../core/src/errors.ts";
import type { ProviderAdapter } from "../../core/src/ports.ts";
import type { ChatMessage, ProviderChatRequest, ProviderChatResponse } from "../../core/src/types.ts";

export class OpenAiCompatibleHttpAdapter implements ProviderAdapter {
  async completeChat(request: ProviderChatRequest): Promise<ProviderChatResponse> {
    const startedAt = Date.now();
    const response = await fetch(`${request.provider.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${request.secretValue}`,
        "content-type": "application/json",
        "x-correlation-id": request.correlationId,
      },
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
  }
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
