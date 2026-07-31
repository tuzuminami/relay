import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const tarballOption = args.indexOf("--tarball");
const tarball = tarballOption === -1 ? undefined : args[tarballOption + 1];
if (tarball === undefined || !tarball.endsWith(".tgz")) {
  console.error("Consumer release check failed: --tarball must point to one package tarball.");
  process.exit(1);
}

const tarballPath = resolve(tarball);
if (!existsSync(tarballPath)) {
  console.error(`Consumer release check failed: package tarball is missing at ${tarballPath}`);
  process.exit(1);
}

const consumerDirectory = mkdtempSync(join(tmpdir(), "relay-release-consumer-"));
try {
  writeFileSync(join(consumerDirectory, "package.json"), JSON.stringify({ name: "relay-release-consumer-check", private: true, type: "module" }, null, 2));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath, "typescript@5.9.3"], { cwd: consumerDirectory, stdio: "pipe" });
  execFileSync(process.execPath, ["--input-type=module", "--eval", 'import("@tuzuminami/relay").then((module) => { if (typeof module.RelayClient !== "function") process.exit(1); })'], { cwd: consumerDirectory, stdio: "pipe" });
  writeFileSync(join(consumerDirectory, "consumer.ts"), [
    'import { RelayClient, type RelayClientOptions } from "@tuzuminami/relay";',
    'const options: RelayClientOptions = { baseUrl: "https://relay.example.test", token: "token", tenantId: "tenant" };',
    "void options;",
    "void RelayClient;"
  ].join("\n"));
  execFileSync(join(consumerDirectory, "node_modules", ".bin", "tsc"), ["--noEmit", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--lib", "ES2022,DOM", "consumer.ts"], { cwd: consumerDirectory, stdio: "pipe" });
  console.log(`Consumer release check passed for ${basename(tarballPath)}.`);
} catch (error) {
  console.error(`Consumer release check failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  rmSync(consumerDirectory, { force: true, recursive: true });
}
