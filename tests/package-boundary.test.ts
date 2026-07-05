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

test("TEST-PACKAGE-001 package dry-run excludes private material", () => {
  const output = execFileSync("pnpm", ["pack", "--dry-run"], { encoding: "utf8" });

  for (const marker of prohibitedPackageMarkers) {
    assert.equal(output.includes(marker), false, `${marker} must not appear in package dry-run output`);
  }
});
