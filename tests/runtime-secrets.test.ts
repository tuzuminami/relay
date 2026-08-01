import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildProductionRuntime } from "../apps/api/src/server.ts";
import { loadRuntimeSecretResolver } from "../apps/api/src/secrets.ts";
import { RelayError } from "../packages/core/src/errors.ts";

async function withSecretResolverModule<T>(source: string, run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "relay-secret-resolver-"));
  const modulePath = join(directory, "resolver.mjs");
  await writeFile(modulePath, source, "utf8");
  try {
    return await run(modulePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("TEST-SECRETS-001 production secret resolver is required and preflighted", async () => {
  const previousModule = process.env.RELAY_SECRET_RESOLVER_MODULE;
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.RELAY_SECRET_RESOLVER_MODULE;
    await assert.rejects(
      () => loadRuntimeSecretResolver(),
      (error) => error instanceof RelayError && error.code === "CONFIGURATION_INVALID",
    );
    await assert.rejects(
      () => buildProductionRuntime(),
      (error) => error instanceof RelayError && error.code === "CONFIGURATION_INVALID",
    );

    await withSecretResolverModule("export const notAResolver = {};", async (modulePath) => {
      process.env.RELAY_SECRET_RESOLVER_MODULE = modulePath;
      await assert.rejects(
        () => loadRuntimeSecretResolver(),
        (error) => error instanceof RelayError && error.code === "CONFIGURATION_INVALID",
      );
    });
  } finally {
    if (previousModule === undefined) delete process.env.RELAY_SECRET_RESOLVER_MODULE;
    else process.env.RELAY_SECRET_RESOLVER_MODULE = previousModule;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("TEST-SECRETS-002 resolver receives the canonical tenant binding and normalizes failures", async () => {
  const previousModule = process.env.RELAY_SECRET_RESOLVER_MODULE;
  try {
    await withSecretResolverModule(
      "export const secretResolver = { async resolveSecret(binding) { if (binding.tenantId !== 'tenant_a' || binding.reference !== 'secret://provider/a' || binding.allowedOrigin !== 'https://api.example.test') throw new Error('binding mismatch'); return 'resolved-secret'; } };",
      async (modulePath) => {
        process.env.RELAY_SECRET_RESOLVER_MODULE = modulePath;
        const resolver = await loadRuntimeSecretResolver();
        assert.equal(
          await resolver.resolveSecret({ tenantId: "tenant_a", reference: "secret://provider/a", allowedOrigin: "https://api.example.test" }),
          "resolved-secret",
        );
      },
    );

    await withSecretResolverModule(
      "export const secretResolver = { async resolveSecret() { throw new Error('vault diagnostic that must never reach callers'); } };",
      async (modulePath) => {
        process.env.RELAY_SECRET_RESOLVER_MODULE = modulePath;
        const resolver = await loadRuntimeSecretResolver();
        await assert.rejects(
          () => resolver.resolveSecret({ tenantId: "tenant_a", reference: "secret://provider/a", allowedOrigin: "https://api.example.test" }),
          (error) => error instanceof RelayError && error.code === "DEPENDENCY_UNAVAILABLE" && error.retryable === true && error.details.length === 0 && !error.message.includes("vault diagnostic"),
        );
      },
    );
  } finally {
    if (previousModule === undefined) delete process.env.RELAY_SECRET_RESOLVER_MODULE;
    else process.env.RELAY_SECRET_RESOLVER_MODULE = previousModule;
  }
});
