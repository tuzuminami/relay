import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function runVersionGate(root: string): string {
  return execFileSync("node", ["scripts/check-version-metadata.mjs", root], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

interface FixtureOptions {
  readonly apiVersion?: string;
  readonly changelogVersion?: string;
  readonly openApiVersion?: string;
  readonly readmeVersion?: string;
  readonly schemaVersion?: string;
}

function writeFixture(root: string, options: FixtureOptions = {}): void {
  const apiVersion = options.apiVersion ?? "v1";
  const changelogVersion = options.changelogVersion ?? "1.0.0";
  const openApiVersion = options.openApiVersion ?? "1.0.0";
  const readmeVersion = options.readmeVersion ?? "1.0.0";
  const schemaVersion = options.schemaVersion ?? "1.0.0";
  mkdirSync(join(root, "packages/contracts/schemas"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "1.0.0" }));
  writeFileSync(join(root, "README.md"), `# RELAY\nRELAY V${readmeVersion} is a policy enforcement point.\n`);
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n## ${changelogVersion} - 2026-07-13\n`);
  writeFileSync(join(root, "packages/contracts/openapi.yaml"), `openapi: 3.1.0\ninfo:\n  title: RELAY API\n  version: ${openApiVersion}\ncomponents:\n  schemas:\n    Meta:\n      type: object\n      properties:\n        apiVersion:\n          type: string\n          const: ${apiVersion}\n`);
  writeFileSync(join(root, "packages/contracts/schemas/request.schema.json"), JSON.stringify({ "$schema": "https://json-schema.org/draft/2020-12/schema", "x-relay-contract-version": schemaVersion }));
}

test("TEST-VERSION-001 release gate accepts aligned package, OpenAPI, schema, and docs metadata", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-version-aligned-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root);

  assert.match(runVersionGate(root), /version-metadata: pass \(1\.0\.0\)/);
});

test("TEST-VERSION-002 release gate rejects OpenAPI release-version drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-version-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, { openApiVersion: "0.2.0" });

  assert.throws(() => runVersionGate(root), /OpenAPI info\.version must equal package version 1\.0\.0/);
});

test("TEST-VERSION-003 release gate rejects schema release-version drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-version-schema-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, { schemaVersion: "0.2.0" });

  assert.throws(() => runVersionGate(root), /request\.schema\.json must declare x-relay-contract-version 1\.0\.0/);
});

test("TEST-VERSION-004 release gate rejects documentation release-version drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-version-docs-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, { changelogVersion: "0.2.0", readmeVersion: "0.2.0" });

  assert.throws(() => runVersionGate(root), /README must name RELAY V1\.0\.0/);
});

test("TEST-VERSION-005 release gate rejects HTTP API major-version drift", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relay-version-api-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFixture(root, { apiVersion: "v2" });

  assert.throws(() => runVersionGate(root), /OpenAPI response metadata must declare apiVersion v1/);
});
