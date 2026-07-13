import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function installedVersion(packageName: string): string {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "node_modules", packageName, "package.json"), "utf8")) as { readonly version: string };
  return manifest.version;
}

test("TEST-PACKAGE-002 packed artifact installs and exposes only supported entrypoints", (t) => {
  const packageDirectory = mkdtempSync(join(tmpdir(), "relay-package-"));
  const consumerDirectory = mkdtempSync(join(tmpdir(), "relay-consumer-"));
  t.after(() => {
    rmSync(packageDirectory, { recursive: true, force: true });
    rmSync(consumerDirectory, { recursive: true, force: true });
  });

  writeFileSync(join(process.cwd(), "dist", "stale-package-artifact.js"), "throw new Error('stale artifact');\n");
  run("pnpm", ["pack", "--pack-destination", packageDirectory], process.cwd());
  const packageFile = join(packageDirectory, "tuzuminami-relay-1.0.0.tgz");
  assert.ok(existsSync(packageFile), "pack must create the expected artifact");

  writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "relay-package-consumer", private: true, type: "module" }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", packageFile], consumerDirectory);
  run("npm", ["install", "--save-dev", "--ignore-scripts", "--no-audit", "--no-fund", `typescript@${installedVersion("typescript")}`, `@types/node@${installedVersion("@types/node")}`], consumerDirectory);

  const program = [
    'import { RelayClient } from "@tuzuminami/relay";',
    'import { authAdapterFailure, createProductionRelayHttpServer } from "@tuzuminami/relay/server";',
    'import { listRelayMigrations, resolveRelayMigrationPath } from "@tuzuminami/relay/migrations";',
    'import { readFileSync } from "node:fs";',
    'import { fileURLToPath } from "node:url";',
    'import { statSync } from "node:fs";',
    'const client = new RelayClient({ baseUrl: "https://relay.example.test", token: "token", tenantId: "tenant" });',
    'if (!(client instanceof RelayClient) || typeof createProductionRelayHttpServer !== "function" || authAdapterFailure("AUTHENTICATION_REQUIRED").code !== "AUTHENTICATION_REQUIRED") process.exit(1);',
    'const migrations = listRelayMigrations();',
    'if (migrations.length !== 1 || !statSync(resolveRelayMigrationPath(migrations[0])).isFile()) process.exit(1);',
    'migrations.push("../package.json");',
    'if (listRelayMigrations().length !== 1) process.exit(1);',
    'try { resolveRelayMigrationPath("../package.json"); process.exit(1); } catch (error) { if (!(error instanceof TypeError)) process.exit(1); }',
    'try { await createProductionRelayHttpServer(); process.exit(1); } catch (error) { if (error?.code !== "CONFIGURATION_INVALID") process.exit(1); }',
    'const openApi = readFileSync(fileURLToPath(import.meta.resolve("@tuzuminami/relay/contracts/openapi.yaml")), "utf8");',
    'const chatSchema = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@tuzuminami/relay/contracts/schemas/chat-completion-request.schema.json")), "utf8"));',
    'const providerSchema = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("@tuzuminami/relay/contracts/schemas/provider-validation-request.schema.json")), "utf8"));',
    'if (!openApi.includes("version: 1.0.0") || chatSchema["x-relay-contract-version"] !== "1.0.0" || providerSchema["x-relay-contract-version"] !== "1.0.0") process.exit(1);',
    'try { await import("@tuzuminami/relay/packages/sdk-ts/src/index"); process.exit(1); } catch (error) { if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") process.exit(1); }'
  ].join("\n");
  run("node", ["--input-type=module", "--eval", program], consumerDirectory);

  writeFileSync(join(consumerDirectory, "index.ts"), [
    'import { RelayClient } from "@tuzuminami/relay";',
    'import { authAdapterFailure, createProductionRelayHttpServer, type AuthAdapter } from "@tuzuminami/relay/server";',
    'import { listRelayMigrations, resolveRelayMigrationPath } from "@tuzuminami/relay/migrations";',
    'const client = new RelayClient({ baseUrl: "https://relay.example.test", token: "token", tenantId: "tenant" });',
    'const server = createProductionRelayHttpServer;',
    'const adapter: AuthAdapter = { authenticate: (_authorization, _tenantHeader, signal) => { void signal; return { actorId: "actor", tenantId: "tenant", scopes: ["relay:invoke"] }; } };',
    'const legacyIdentity = { actorId: "actor", tenantId: "tenant", scopes: ["relay:invoke"], authAdapter: "test" as const };',
    'const legacyAdapter: AuthAdapter = { authenticate: (_authorization, _tenantHeader) => legacyIdentity };',
    'const failure = authAdapterFailure("AUTHENTICATION_REQUIRED");',
    'const path = resolveRelayMigrationPath(listRelayMigrations()[0]);',
    'void client; void server; void adapter; void legacyAdapter; void failure; void path;'
  ].join("\n"));
  writeFileSync(join(consumerDirectory, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", noEmit: true, strict: true, target: "ES2024", types: ["node"] } }));
  run("npx", ["tsc", "--project", "tsconfig.json"], consumerDirectory);

  const installedManifest = JSON.parse(readFileSync(join(consumerDirectory, "node_modules/@tuzuminami/relay/package.json"), "utf8")) as { readonly files?: readonly string[] };
  assert.deepEqual(installedManifest.files, ["dist", "db/migrations", "docs/brand/banner.svg", "packages/contracts", "README.md", "LICENSE", "SECURITY.md", "CHANGELOG.md"]);
  assert.equal(existsSync(fileURLToPath(import.meta.resolve("@tuzuminami/relay/contracts/openapi.yaml"))), true);
  assert.equal(existsSync(join(consumerDirectory, "node_modules/@tuzuminami/relay/dist/apps/api/src/main.js")), false, "unsupported CLI entrypoint must not be installed");
  assert.equal(existsSync(join(consumerDirectory, "node_modules/@tuzuminami/relay/dist/stale-package-artifact.js")), false, "prepack must rebuild from a clean dist directory");
  assert.equal(basename(packageFile), "tuzuminami-relay-1.0.0.tgz");
});
