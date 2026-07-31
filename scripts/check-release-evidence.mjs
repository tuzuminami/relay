import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  console.error(`Release evidence check failed: ${message}`);
  process.exit(1);
}

const tag = option("--tag");
if (!tag || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  fail("--tag must be a semver tag such as v1.2.3");
}

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (tag.slice(1) !== packageJson.version) fail(`tag ${tag} does not match package version ${packageJson.version}`);

const artifactDirectory = resolve(option("--artifacts") ?? "artifacts");
const sbomPath = resolve(option("--sbom") ?? join(artifactDirectory, "relay.cdx.json"));
if (!existsSync(sbomPath)) fail(`SBOM is missing at ${sbomPath}`);

const sbom = JSON.parse(readFileSync(sbomPath, "utf8"));
if (sbom.bomFormat !== "CycloneDX") fail("SBOM must use the CycloneDX JSON format");
const sbomPackageName = sbom.metadata?.component?.group
  ? `${sbom.metadata.component.group}/${sbom.metadata.component.name}`
  : sbom.metadata?.component?.name;
if (sbomPackageName !== packageJson.name) fail("SBOM root component name does not match package.json");
if (sbom.metadata?.component?.version !== packageJson.version) fail("SBOM root component version does not match package.json");

const tarballs = readdirSync(artifactDirectory).filter((entry) => entry.endsWith(".tgz")).map((entry) => join(artifactDirectory, entry));
if (tarballs.length !== 1) fail("release evidence must contain exactly one package tarball");

const files = [...tarballs, sbomPath].sort();
const checksums = files.map((file) => `${createHash("sha256").update(readFileSync(file)).digest("hex")}  ${basename(file)}`).join("\n");
mkdirSync(artifactDirectory, { recursive: true });
writeFileSync(join(artifactDirectory, "SHA256SUMS"), `${checksums}\n`);

for (const file of [...files, join(artifactDirectory, "SHA256SUMS")]) {
  if (!statSync(file).isFile()) fail(`expected a file at ${file}`);
}

console.log(`Release evidence check passed for ${tag}: ${files.length} artifacts and SHA256SUMS.`);
