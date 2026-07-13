import { RelayError } from "../../../packages/core/src/errors.ts";
import { isProductionRuntime, runtimeAuthModeFromEnvironment } from "../../../packages/core/src/provider-url.ts";
import type { AuthContext } from "../../../packages/core/src/types.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface AuthAdapter {
  authenticate(authorization: string | undefined, tenantHeader: string | undefined): AuthContext | Promise<AuthContext>;
}

/**
 * Production adapters may reject with this structural value. RELAY deliberately
 * ignores adapter-provided messages and details, and maps only these codes to
 * its fixed public HTTP contract.
 */
export type AuthAdapterFailure = Readonly<{
  code: "AUTHENTICATION_REQUIRED" | "TENANT_SCOPE_DENIED" | "DEPENDENCY_UNAVAILABLE";
}>;

export function authAdapterFailure(code: AuthAdapterFailure["code"]): AuthAdapterFailure {
  return Object.freeze({ code });
}

const DEFAULT_AUTH_ADAPTER_TIMEOUT_MS = 5_000;
const MAX_AUTH_ADAPTER_TIMEOUT_MS = 30_000;

class AuthAdapterTimeoutError extends Error {}

export class DevelopmentAuthAdapter implements AuthAdapter {
  private readonly authAdapter: "development" | "test";

  constructor(authAdapter: "development" | "test" = "development") {
    this.authAdapter = authAdapter;
  }

  authenticate(authorization: string | undefined, tenantHeader: string | undefined): AuthContext {
    if (authorization === undefined || !authorization.startsWith("Bearer ")) {
      throw new RelayError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    }
    if (tenantHeader === undefined || tenantHeader.length === 0) {
      throw new RelayError("TENANT_SCOPE_DENIED", "Request cannot access this resource.", 403);
    }
    const token = authorization.slice("Bearer ".length);
    const parts = token.split(":");
    if (parts.length < 4 || parts[0] !== "dev") {
      throw new RelayError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
    }
    const [, actorId, tenantId, ...scopeParts] = parts;
    const scopesRaw = scopeParts.join(":");
    if (actorId === undefined || tenantId === undefined || scopesRaw === undefined || tenantId !== tenantHeader) {
      throw new RelayError("TENANT_SCOPE_DENIED", "Request cannot access this resource.", 403);
    }
    return {
      actorId,
      tenantId,
      scopes: scopesRaw.split(",").filter((scope) => scope.length > 0),
      authAdapter: this.authAdapter,
    };
  }
}

export async function authenticate(authorization: string | undefined, tenantHeader: string | undefined): Promise<AuthContext> {
  return authenticateRequest(buildRuntimeAuthAdapter(), authorization, tenantHeader);
}

export async function authenticateRequest(
  authAdapter: AuthAdapter,
  authorization: string | undefined,
  tenantHeader: string | undefined,
): Promise<AuthContext> {
  if (tenantHeader === undefined || tenantHeader.trim().length === 0) {
    throw tenantScopeDenied();
  }

  let adapterResult: unknown;
  try {
    adapterResult = await authenticateWithTimeout(authAdapter, authorization, tenantHeader);
  } catch (error) {
    throw safeAuthAdapterError(error);
  }

  return snapshotAuthContext(adapterResult, tenantHeader);
}

export function buildRuntimeAuthAdapter(): AuthAdapter {
  const adapter = runtimeAuthModeFromEnvironment();
  if (adapter === "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production auth must be loaded before server startup.", 503);
  }
  validateRuntimeAuthMode();
  return new DevelopmentAuthAdapter(adapter === "test" ? "test" : "development");
}

export async function loadRuntimeAuthAdapter(): Promise<AuthAdapter> {
  const adapter = runtimeAuthModeFromEnvironment();
  if (adapter !== "production") {
    return buildRuntimeAuthAdapter();
  }
  const modulePath = process.env.RELAY_AUTH_MODULE;
  if (modulePath === undefined || modulePath.trim().length === 0) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_AUTH_MODULE.", 503);
  }
  const moduleUrl = modulePath.startsWith("file:") ? modulePath : pathToFileURL(resolve(process.cwd(), modulePath)).href;
  const loaded: unknown = await import(moduleUrl);
  const authAdapter = typeof loaded === "object" && loaded !== null && "authAdapter" in loaded
    ? (loaded as { readonly authAdapter?: unknown }).authAdapter
    : undefined;
  if (typeof authAdapter !== "object" || authAdapter === null ||
      typeof (authAdapter as { readonly authenticate?: unknown }).authenticate !== "function") {
    throw new RelayError("CONFIGURATION_INVALID", "RELAY_AUTH_MODULE must export authAdapter.authenticate().", 503);
  }
  return authAdapter as AuthAdapter;
}

export function validateRuntimeAuthMode(): void {
  const adapter = runtimeAuthModeFromEnvironment();
  if (isProductionRuntime() && adapter !== "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires a production auth adapter.", 503);
  }
}

async function authenticateWithTimeout(
  authAdapter: AuthAdapter,
  authorization: string | undefined,
  tenantHeader: string,
): Promise<unknown> {
  const timeoutMs = authAdapterTimeoutFromEnvironment();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      Promise.resolve(authAdapter.authenticate(authorization, tenantHeader)),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new AuthAdapterTimeoutError()), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function authAdapterTimeoutFromEnvironment(): number {
  const configured = process.env.RELAY_AUTH_TIMEOUT_MS;
  if (configured === undefined || configured.length === 0) return DEFAULT_AUTH_ADAPTER_TIMEOUT_MS;
  const timeoutMs = Number(configured);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_AUTH_ADAPTER_TIMEOUT_MS) {
    throw new RelayError(
      "CONFIGURATION_INVALID",
      `RELAY_AUTH_TIMEOUT_MS must be an integer between 1 and ${MAX_AUTH_ADAPTER_TIMEOUT_MS}.`,
      503,
    );
  }
  return timeoutMs;
}

function snapshotAuthContext(value: unknown, tenantHeader: string): AuthContext {
  if (typeof value !== "object" || value === null) {
    throw invalidAuthAdapterResponse();
  }
  const context = value as Partial<AuthContext>;
  let actorId: unknown;
  let tenantId: unknown;
  let scopesValue: unknown;
  let authAdapter: unknown;
  try {
    actorId = context.actorId;
    tenantId = context.tenantId;
    scopesValue = context.scopes;
    authAdapter = context.authAdapter;
  } catch {
    throw invalidAuthAdapterResponse();
  }

  if (
    typeof actorId !== "string" || actorId.length === 0 ||
    typeof tenantId !== "string" || tenantId.length === 0 ||
    !Array.isArray(scopesValue) ||
    (authAdapter !== "development" && authAdapter !== "test" && authAdapter !== "production")
  ) {
    throw invalidAuthAdapterResponse();
  }

  const scopes: string[] = [];
  try {
    for (const scope of scopesValue) {
      if (typeof scope !== "string" || scope.length === 0) throw new TypeError("Invalid scope.");
      scopes.push(scope);
    }
  } catch {
    throw invalidAuthAdapterResponse();
  }

  if (tenantHeader !== tenantId) throw tenantScopeDenied();
  return { actorId, tenantId, scopes: Object.freeze(scopes), authAdapter };
}

function safeAuthAdapterError(error: unknown): RelayError {
  if (error instanceof AuthAdapterTimeoutError) {
    return new RelayError("DEPENDENCY_UNAVAILABLE", "Authentication dependency is unavailable.", 503, ["auth_adapter_timeout"], true);
  }
  const code = authAdapterFailureCode(error);
  if (code === "AUTHENTICATION_REQUIRED") {
    return new RelayError("AUTHENTICATION_REQUIRED", "Authentication is required.", 401);
  }
  if (code === "TENANT_SCOPE_DENIED") return tenantScopeDenied();
  return new RelayError("DEPENDENCY_UNAVAILABLE", "Authentication dependency is unavailable.", 503, ["auth_adapter_unavailable"], true);
}

function authAdapterFailureCode(error: unknown): AuthAdapterFailure["code"] | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  try {
    const code = (error as { readonly code?: unknown }).code;
    return code === "AUTHENTICATION_REQUIRED" || code === "TENANT_SCOPE_DENIED" || code === "DEPENDENCY_UNAVAILABLE"
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

function tenantScopeDenied(): RelayError {
  return new RelayError("TENANT_SCOPE_DENIED", "Request cannot access this resource.", 403);
}

function invalidAuthAdapterResponse(): RelayError {
  return new RelayError("DEPENDENCY_UNAVAILABLE", "Authentication dependency returned an invalid identity.", 503, ["auth_adapter_invalid_response"], true);
}
