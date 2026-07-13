import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const rootDirectory = resolve(process.argv[2] ?? new URL("../", import.meta.url).pathname);

async function read(relativePath) {
  return readFile(resolve(rootDirectory, relativePath), "utf8");
}

function fail(message) {
  throw new Error(`version-metadata: ${message}`);
}

const packageManifest = JSON.parse(await read("package.json"));
const releaseVersion = packageManifest.version;
if (typeof releaseVersion !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseVersion)) {
  fail("package.json must contain a SemVer release version");
}

const openApi = await read("packages/contracts/openapi.yaml");
const openApiVersion = /^info:\n(?:.*\n)*?  version:\s*([^\s#]+)\s*$/m.exec(openApi)?.[1];
if (openApiVersion !== releaseVersion) {
  fail(`OpenAPI info.version must equal package version ${releaseVersion}`);
}
const apiCompatibilityVersion = /apiVersion:\s*\n\s+type:\s+string\s*\n\s+const:\s*(v\d+)/.exec(openApi)?.[1];
if (apiCompatibilityVersion !== "v1") {
  fail("OpenAPI response metadata must declare apiVersion v1");
}

const schemaDirectory = resolve(rootDirectory, "packages/contracts/schemas");
const schemaFiles = (await readdir(schemaDirectory)).filter((file) => file.endsWith(".json"));
if (schemaFiles.length === 0) {
  fail("at least one request schema is required");
}
for (const file of schemaFiles) {
  const schema = JSON.parse(await read(`packages/contracts/schemas/${file}`));
  if (schema["x-relay-contract-version"] !== releaseVersion) {
    fail(`${file} must declare x-relay-contract-version ${releaseVersion}`);
  }
}

const readme = await read("README.md");
const readmeStatusVersion = /^RELAY V([^\s]+) is /m.exec(readme)?.[1];
if (readmeStatusVersion !== releaseVersion) {
  fail(`README must name RELAY V${releaseVersion}`);
}

const changelog = await read("CHANGELOG.md");
if (!changelog.includes(`## ${releaseVersion} -`)) {
  fail(`CHANGELOG must contain the ${releaseVersion} release heading`);
}

process.stdout.write(`version-metadata: pass (${releaseVersion})\n`);
