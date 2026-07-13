import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

const prohibitedPackageMarkers = [
  "CODEX_AI_COMPANION",
  "CODEX_IMPLEMENTATION_HARNESS",
  "README_PRIVATE",
  "AGENTS_PRIVATE",
  "01_BMA",
  "02_StRS",
  "03_SyRS",
  "04_AD",
  "05_DD",
  "06_API_CONTRACT",
  "07_VV_PLAN",
  "08_TRACEABILITY",
  "09_MVP_BACKLOG",
  "10_RELEASE_CRITERIA",
];

interface PackageFile {
  readonly path: string;
}

interface PackResult {
  readonly files: readonly PackageFile[];
}

test("TEST-PACKAGE-001 package dry-run excludes private material", () => {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
  const parsed = JSON.parse(output) as PackResult | readonly PackResult[];
  const pack: PackResult = Array.isArray(parsed) ? parsed[0]! : parsed;
  const paths = pack.files.map((file) => file.path);

  for (const marker of prohibitedPackageMarkers) {
    assert.equal(output.includes(marker), false, `${marker} must not appear in package dry-run output`);
  }

  for (const path of paths) {
    assert.equal(/^(apps|scripts|tests|db\/seeds)\//.test(path), false, `${path} must not be shipped as source or development material`);
    assert.equal(path.startsWith("packages/") && !path.startsWith("packages/contracts/"), false, `${path} must not be shipped as source or development material`);
  }

  assert.ok(paths.includes("dist/packages/sdk-ts/src/index.js"));
  assert.ok(paths.includes("dist/packages/server/index.js"));
  assert.ok(paths.includes("dist/migrations/index.js"));
  assert.ok(paths.includes("db/migrations/0001_initial.sql"));
  assert.ok(paths.includes("packages/contracts/openapi.yaml"));
  assert.ok(paths.includes("packages/contracts/schemas/chat-completion-request.schema.json"));
  assert.ok(paths.includes("packages/contracts/schemas/provider-validation-request.schema.json"));
  assert.equal(paths.includes("dist/apps/api/src/main.js"), false, "unsupported CLI entrypoint must not be shipped");
});
