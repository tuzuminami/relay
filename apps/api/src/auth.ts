import { RelayError } from "../../../packages/core/src/errors.ts";
import type { AuthContext } from "../../../packages/core/src/types.ts";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface AuthAdapter {
  authenticate(authorization: string | undefined, tenantHeader: string | undefined): AuthContext;
}

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

export function authenticate(authorization: string | undefined, tenantHeader: string | undefined): AuthContext {
  return buildRuntimeAuthAdapter().authenticate(authorization, tenantHeader);
}

export function buildRuntimeAuthAdapter(): AuthAdapter {
  const adapter = process.env.RELAY_AUTH_ADAPTER ?? "development";
  if (adapter === "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production auth must be loaded before server startup.", 503);
  }
  validateRuntimeAuthMode();
  return new DevelopmentAuthAdapter(adapter === "test" ? "test" : "development");
}

export async function loadRuntimeAuthAdapter(): Promise<AuthAdapter> {
  const adapter = process.env.RELAY_AUTH_ADAPTER ?? "development";
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
  const adapter = process.env.RELAY_AUTH_ADAPTER ?? "development";
  if (process.env.NODE_ENV === "production" && adapter !== "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires a production auth adapter.", 503);
  }
}
