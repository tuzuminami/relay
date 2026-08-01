import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RelayError } from "../../../packages/core/src/errors.ts";
import { allowedOriginsFromEnvironment, canonicalProviderOrigin, isProductionRuntime, providerBaseUrlRejectionReasons, type ProviderEgressPolicy } from "../../../packages/core/src/provider-url.ts";
import { RelayService } from "../../../packages/core/src/relay-service.ts";
import { parseChatCompletionRequest, parseProviderValidationRequest, parseRouteQuery } from "../../../packages/core/src/validation.ts";
import { createRemoteVeilDecisionVerifier, defaultProviderConfig, defaultRoute, InMemoryRelayStore, InMemoryUsageRepository, InMemoryVeilDecisionReplayStore, OpenAiCompatibleHttpAdapter, PostgresRelayStore, SequentialIdGenerator, StaticSecretResolver, SystemClock } from "../../../packages/adapters/src/index.ts";
import type { SecretResolver } from "../../../packages/core/src/ports.ts";
import { authAdapterTimeoutFromEnvironment, authenticateRequest, buildRuntimeAuthAdapter, type AuthAdapter } from "./auth.ts";
import { loadRuntimeSecretResolver } from "./secrets.ts";

export function buildDefaultService(): RelayService {
  if (isProductionRuntime()) {
    // Preserve configuration validation for callers that accidentally reach the development builder.
    runtimeProviderEgressPolicy();
    runtimeVeilDecisionVerifier();
  }
  return buildRuntime({ secretResolver: developmentSecretResolver() }).service;
}

export async function buildRuntimeService(): Promise<RelayRuntime> {
  const secretResolver = isProductionRuntime()
    ? await loadRuntimeSecretResolver()
    : developmentSecretResolver();
  return buildRuntime({ secretResolver });
}

export async function buildProductionRuntime(): Promise<RelayRuntime> {
  if (!isProductionRuntime()) {
    throw new RelayError("CONFIGURATION_INVALID", "Production runtime configuration is required.", 503);
  }
  return buildRuntimeService();
}

export interface RelayRuntime {
  readonly service: RelayService;
  readonly readiness: () => Promise<void>;
}

function buildRuntime(options: { readonly secretResolver: SecretResolver }): RelayRuntime {
  const providerEgressPolicy = runtimeProviderEgressPolicy();
  const veilDecisionVerifier = runtimeVeilDecisionVerifier();
  const veilVerifierPort = veilDecisionVerifier === undefined ? {} : { veilDecisionVerifier };
  if (process.env.RELAY_DATABASE_URL !== undefined) {
    const pool = new Pool({
      connectionString: process.env.RELAY_DATABASE_URL,
      connectionTimeoutMillis: 2_000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true,
    });
    const store = new PostgresRelayStore(pool);
    const provider = defaultProviderConfig();
    return {
      service: new RelayService({
        routes: store,
        provider: new OpenAiCompatibleHttpAdapter({ secretResolver: options.secretResolver, egressPolicy: providerEgressPolicy }),
        audit: store,
        usage: store,
        idempotency: store,
        completions: store,
        clock: new SystemClock(),
        ids: new SequentialIdGenerator(),
        providerEgressPolicy,
        ...veilVerifierPort,
        veilDecisionReplay: store,
      }),
      readiness: () => store.checkReadiness(),
    };
  }
  const provider = defaultProviderConfig();
  const providerBaseUrlRejections = providerBaseUrlRejectionReasons(provider.baseUrl, providerEgressPolicy);
  if (providerBaseUrlRejections.length > 0) {
    throw new RelayError("CONFIGURATION_INVALID", "Configured provider base URL is not permitted.", 503, providerBaseUrlRejections);
  }
  const store = new InMemoryRelayStore([defaultRoute()], [provider]);
  return {
    service: new RelayService({
      routes: store,
      provider: new OpenAiCompatibleHttpAdapter({ secretResolver: options.secretResolver, egressPolicy: providerEgressPolicy }),
      audit: store,
      usage: new InMemoryUsageRepository(store),
      idempotency: store,
      completions: store,
      clock: new SystemClock(),
      ids: new SequentialIdGenerator(),
      providerEgressPolicy,
      ...veilVerifierPort,
      veilDecisionReplay: new InMemoryVeilDecisionReplayStore(),
    }),
    readiness: async () => {},
  };
}

function runtimeVeilDecisionVerifier() {
  const issuer = process.env.RELAY_VEIL_ISSUER;
  const audience = process.env.RELAY_VEIL_AUDIENCE;
  const jwksUrl = process.env.RELAY_VEIL_JWKS_URL;
  const configured = [issuer, audience, jwksUrl].filter((value) => value !== undefined && value.length > 0).length;
  if (configured !== 0 && configured !== 3) {
    throw new RelayError("CONFIGURATION_INVALID", "RELAY_VEIL_ISSUER, RELAY_VEIL_AUDIENCE, and RELAY_VEIL_JWKS_URL must be configured together.", 503);
  }
  if (isProductionRuntime() && configured !== 3) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_VEIL_ISSUER, RELAY_VEIL_AUDIENCE, and RELAY_VEIL_JWKS_URL.", 503);
  }
  if (isProductionRuntime() && process.env.RELAY_DATABASE_URL === undefined) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_DATABASE_URL for persistent VEIL decision replay protection.", 503);
  }
  if (configured === 3) {
    let url: URL;
    try {
      url = new URL(jwksUrl!);
    } catch {
      throw new RelayError("CONFIGURATION_INVALID", "RELAY_VEIL_JWKS_URL must be a valid URL.", 503);
    }
    if (isProductionRuntime() && url.protocol !== "https:") {
      throw new RelayError("CONFIGURATION_INVALID", "Production requires an HTTPS RELAY_VEIL_JWKS_URL.", 503);
    }
  }
  return configured === 3
    ? createRemoteVeilDecisionVerifier({ issuer: issuer!, audience: audience!, jwksUrl: jwksUrl! })
    : undefined;
}

export function runtimeProviderEgressPolicy(): ProviderEgressPolicy {
  const production = isProductionRuntime();
  const allowedOrigins = allowedOriginsFromEnvironment(process.env.RELAY_PROVIDER_ALLOWED_ORIGINS);
  if (production && allowedOrigins.length === 0) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_PROVIDER_ALLOWED_ORIGINS.", 503, ["BASE_URL_ORIGIN_NOT_ALLOWED"]);
  }
  return { production, allowedOrigins };
}

export function createRelayHttpServer(
  service: RelayService = buildDefaultService(),
  authAdapter: AuthAdapter = buildRuntimeAuthAdapter(),
  readiness: () => Promise<void> = async () => {}
) {
  const authTimeoutMs = authAdapterTimeoutFromEnvironment();
  return createServer(async (req, res) => {
    try {
      await handleRequest(req, res, service, authAdapter, authTimeoutMs, readiness);
    } catch (error) {
      writeError(res, error, req.headers["x-correlation-id"]);
    }
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: RelayService,
  authAdapter: AuthAdapter,
  authTimeoutMs: number,
  readiness: () => Promise<void>,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    writeJson(res, 200, { data: { status: "ok" }, meta: meta(req) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/ready") {
    try {
      await readiness();
    } catch {
      throw new RelayError("DEPENDENCY_UNAVAILABLE", "Runtime is not ready.", 503, [], true);
    }
    writeJson(res, 200, { data: { status: "ready" }, meta: meta(req) });
    return;
  }

  const auth = await authenticateRequest(authAdapter, singleHeader(req.headers.authorization), singleHeader(req.headers["x-tenant-id"]), authTimeoutMs);
  const ctx = {
    auth,
    requestId: randomUUID(),
    correlationId: singleHeader(req.headers["x-correlation-id"]) ?? randomUUID(),
    now: new Date(),
  };

  if (req.method === "GET" && url.pathname === "/v1/routes/resolve") {
    const query = parseRouteQuery(url.searchParams);
    const resolution = await service.resolve(ctx, query);
    writeJson(res, resolution.allowed ? 200 : 403, { data: redactedResolution(resolution), meta: meta(req, ctx.correlationId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const body = parseChatCompletionRequest(await readJson(req));
    const idempotencyKey = singleHeader(req.headers["idempotency-key"]) ?? "";
    const token = singleHeader(req.headers["x-veil-enforcement"]);
    const response = await service.completeChat(ctx, body, idempotencyKey, token === undefined ? undefined : { token });
    writeJson(res, 200, { data: response, meta: meta(req, ctx.correlationId) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/usage") {
    const records = await service.listUsage(ctx);
    writeJson(res, 200, { data: { usage: records.map(redactedUsage) }, meta: meta(req, ctx.correlationId) });
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/providers/validate") {
    const body = parseProviderValidationRequest(await readJson(req));
    const result = await service.validateProvider(ctx, body);
    writeJson(res, result.valid ? 200 : 422, { data: result, meta: meta(req, ctx.correlationId) });
    return;
  }

  throw new RelayError("VALIDATION_FAILED", "Route not found.", 404);
}

function developmentSecretResolver(): SecretResolver {
  if (isProductionRuntime()) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_SECRET_RESOLVER_MODULE.", 503);
  }
  const secret = process.env.RELAY_PROVIDER_API_KEY;
  const value = secret !== undefined && secret.length > 0 ? secret : "dev-placeholder";
  const provider = defaultProviderConfig();
  return new StaticSecretResolver(new Map([[provider.secretReference, { value, tenantId: provider.tenantId, allowedOrigin: canonicalProviderOrigin(provider.baseUrl) }]]));
}

function redactedUsage(record: Awaited<ReturnType<RelayService["listUsage"]>>[number]): Record<string, unknown> {
  return {
    id: record.id,
    requestId: record.requestId,
    routeId: record.routeId,
    providerId: record.providerId,
    model: record.model,
    inputTokens: record.usage.inputTokens,
    outputTokens: record.usage.outputTokens,
    estimatedCostCents: record.usage.estimatedCostCents,
    latencyMs: record.latencyMs,
    terminalReason: record.terminalReason,
    correlationId: record.correlationId,
    createdAt: record.createdAt.toISOString(),
  };
}

function redactedResolution(resolution: Awaited<ReturnType<RelayService["resolve"]>>): Record<string, unknown> {
  return {
    allowed: resolution.allowed,
    reasonCodes: resolution.reasonCodes,
    route: resolution.route === undefined ? undefined : {
      routeId: resolution.route.routeId,
      providerId: resolution.route.providerId,
      model: resolution.route.model,
      requiredCapabilities: resolution.route.requiredCapabilities,
      maxCostCents: resolution.route.maxCostCents,
    },
    provider: resolution.provider === undefined ? undefined : {
      providerId: resolution.provider.providerId,
      adapterType: resolution.provider.adapterType,
      capabilities: resolution.provider.capabilities,
    },
  };
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function writeError(res: ServerResponse, error: unknown, correlationHeader: string | string[] | undefined): void {
  const correlationId = singleHeader(correlationHeader) ?? randomUUID();
  if (error instanceof RelayError) {
    writeJson(res, error.status, {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        correlationId,
      },
    });
    return;
  }
  writeJson(res, 500, {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "Unexpected failure.",
      details: [],
      correlationId,
    },
  });
}

function meta(req: IncomingMessage, correlationId = singleHeader(req.headers["x-correlation-id"]) ?? randomUUID()): Record<string, string> {
  return {
    requestId: randomUUID(),
    correlationId,
    apiVersion: "v1",
  };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
