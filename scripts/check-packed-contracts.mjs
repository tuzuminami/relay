import { execFileSync } from "node:child_process";

const expectedPaths = [
  "packages/contracts/openapi.yaml",
  "packages/contracts/schemas/chat-completion-request.schema.json",
  "packages/contracts/schemas/provider-validation-request.schema.json"
];

const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" });
const parsed = JSON.parse(output);
const pack = Array.isArray(parsed) ? parsed[0] : parsed;
if (!pack || typeof pack !== "object" || !Array.isArray(pack.files)) throw new Error("packed-contracts: npm pack did not return a file manifest");

const paths = new Set(pack.files.map((file) => file?.path));
for (const expectedPath of expectedPaths) {
  if (!paths.has(expectedPath)) throw new Error(`packed-contracts: missing ${expectedPath}`);
}

console.log(`packed-contracts: pass (${expectedPaths.length} public contract files)`);
