import { RelayError } from "../../../packages/core/src/errors.ts";
import type { AuthContext } from "../../../packages/core/src/types.ts";

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
  validateRuntimeAuthMode();
  const adapter = process.env.RELAY_AUTH_ADAPTER ?? "development";
  return new DevelopmentAuthAdapter(adapter === "test" ? "test" : "development");
}

export function validateRuntimeAuthMode(): void {
  const adapter = process.env.RELAY_AUTH_ADAPTER ?? "development";
  if (process.env.NODE_ENV === "production" && adapter !== "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires a production auth adapter.", 503);
  }
  if (adapter === "production") {
    throw new RelayError("CONFIGURATION_INVALID", "Production auth adapter is not implemented in this OSS MVP.", 503);
  }
}
