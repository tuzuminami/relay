import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { RelayError } from "../../../packages/core/src/errors.ts";
import type { SecretBinding, SecretResolver } from "../../../packages/core/src/ports.ts";

interface ResolverModule {
  readonly secretResolver?: unknown;
}

export async function loadRuntimeSecretResolver(): Promise<SecretResolver> {
  const modulePath = process.env.RELAY_SECRET_RESOLVER_MODULE;
  if (modulePath === undefined || modulePath.trim().length === 0) {
    throw new RelayError("CONFIGURATION_INVALID", "Production requires RELAY_SECRET_RESOLVER_MODULE.", 503);
  }
  let loaded: ResolverModule;
  try {
    const moduleUrl = modulePath.startsWith("file:") ? modulePath : pathToFileURL(resolve(process.cwd(), modulePath)).href;
    loaded = await import(moduleUrl) as ResolverModule;
  } catch {
    throw new RelayError("CONFIGURATION_INVALID", "RELAY_SECRET_RESOLVER_MODULE could not be loaded.", 503);
  }
  if (typeof loaded.secretResolver !== "object" || loaded.secretResolver === null ||
      typeof (loaded.secretResolver as { readonly resolveSecret?: unknown }).resolveSecret !== "function") {
    throw new RelayError("CONFIGURATION_INVALID", "RELAY_SECRET_RESOLVER_MODULE must export secretResolver.resolveSecret().", 503);
  }
  const resolver = loaded.secretResolver as SecretResolver;
  return {
    async resolveSecret(binding: SecretBinding): Promise<string> {
      try {
        const value = await resolver.resolveSecret(binding);
        if (typeof value !== "string" || value.length === 0) {
          throw new TypeError("Resolver returned an invalid secret.");
        }
        return value;
      } catch {
        throw new RelayError("DEPENDENCY_UNAVAILABLE", "Configured secret reference is unavailable.", 503, [], true);
      }
    },
  };
}
