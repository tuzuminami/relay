export interface RelayClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly tenantId: string;
  readonly correlationId?: string;
}

export interface RelayEnvelope<T> {
  readonly data: T;
  readonly meta: {
    readonly requestId: string;
    readonly correlationId: string;
    readonly apiVersion: string;
  };
}

export class RelayClient {
  private readonly options: RelayClientOptions;

  constructor(options: RelayClientOptions) {
    this.options = options;
  }

  async resolveRoute(query: {
    readonly purpose: string;
    readonly dataClassification: string;
    readonly capability: readonly string[];
    readonly maxCostCents: number;
  }): Promise<RelayEnvelope<unknown>> {
    const url = new URL("/v1/routes/resolve", this.options.baseUrl);
    url.searchParams.set("purpose", query.purpose);
    url.searchParams.set("dataClassification", query.dataClassification);
    url.searchParams.set("maxCostCents", String(query.maxCostCents));
    for (const capability of query.capability) {
      url.searchParams.append("capability", capability);
    }
    return this.request(url, { method: "GET" });
  }

  async completeChat(body: unknown, idempotencyKey: string, veilEnforcementToken: string): Promise<RelayEnvelope<unknown>> {
    return this.request(new URL("/v1/chat/completions", this.options.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
        "x-veil-enforcement": veilEnforcementToken,
      },
      body: JSON.stringify(body),
    });
  }

  async listUsage(): Promise<RelayEnvelope<unknown>> {
    return this.request(new URL("/v1/usage", this.options.baseUrl), { method: "GET" });
  }

  async validateProvider(body: unknown): Promise<RelayEnvelope<unknown>> {
    return this.request(new URL("/v1/providers/validate", this.options.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private async request<T>(url: URL, init: RequestInit): Promise<RelayEnvelope<T>> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${this.options.token}`);
    headers.set("x-tenant-id", this.options.tenantId);
    if (this.options.correlationId !== undefined) {
      headers.set("x-correlation-id", this.options.correlationId);
    }
    const response = await fetch(url, { ...init, headers });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      throw new Error(`RELAY request failed with HTTP ${response.status}`);
    }
    return payload as RelayEnvelope<T>;
  }
}
