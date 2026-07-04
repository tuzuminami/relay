import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const prohibitedPathPatterns = [
  /(^|\/)CODEX(_AI_COMPANION_OSS)?_IMPLEMENTATION_HARNESS\.md$/,
  /(^|\/)(AGENTS\.private|AGENTS_PRIVATE|README_PRIVATE)\.md$/,
  /^docs\/(00_GLOSSARY|01_BMA|02_StRS|03_SyRS|04_AD|05_DD|06_API_CONTRACT|07_VV_PLAN|08_TRACEABILITY|09_MVP_BACKLOG|10_RELEASE_CRITERIA)\.md$/,
  /(^|\/)(private-ai-control-plane|\.private|\.codex-private|\.serena|evidence-private|private-fixtures)(\/|$)/,
  /^docs\/(ai|private)(\/|$)/,
  /(^|\/)\.env(\.|$)/,
  /\.(sqlite|db|dump|jsonl)$/i,
];

const privateMarkers = [
  "PRIVATE_" + "OPERATOR_MATERIAL",
  "PRIVATE_" + "SPECIFICATION_DO_NOT_COMMIT",
  "DO_NOT_" + "COMMIT_OR_PUBLISH",
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function fail(message) {
  process.stderr.write(`private-boundary: ${message}\n`);
  process.exitCode = 1;
}

let files = [];
let stagedDeleted = new Set();
try {
  stagedDeleted = new Set(
    execFileSync("git", ["diff", "--cached", "--name-status"], { encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter(([status]) => status === "D")
      .map(([, file]) => file)
      .filter(Boolean),
  );
  files = [...new Set([...git(["ls-files"]), ...git(["diff", "--cached", "--name-only"])])].filter(
    (file) => !stagedDeleted.has(file),
  );
} catch (error) {
  fail(`could not inspect git file set: ${String(error)}`);
}

for (const file of files) {
  if (prohibitedPathPatterns.some((pattern) => pattern.test(file))) {
    fail(`prohibited path is tracked or staged: ${file}`);
    continue;
  }
  try {
    const content = readFileSync(file, "utf8");
    if (privateMarkers.some((marker) => content.includes(marker))) {
      fail(`private marker found in ${file}`);
    }
  } catch (error) {
    fail(`could not inspect ${file}: ${String(error)}`);
  }
}

if (process.exitCode === undefined) {
  process.stdout.write("private-boundary: pass\n");
}
