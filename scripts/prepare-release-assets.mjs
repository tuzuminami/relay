import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const outputDirectory = readOutputDirectory(process.argv.slice(2));

if (readdirSync(outputDirectory).length !== 0) {
  throw new Error(`release-assets: output directory must be empty: ${outputDirectory}`);
}

exec("pnpm", ["run", "build"]);
exec("pnpm", ["pack", "--pack-destination", outputDirectory]);

const tarball = resolve(outputDirectory, `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`);
smokeInstalledTarball(tarball);
writeEvidence(tarball, outputDirectory);
console.log(`Release assets prepared in ${outputDirectory}.`);

function readOutputDirectory(args) {
  const index = args.indexOf("--output-dir");
  if (index === -1 || !args[index + 1]) throw new Error("release-assets: pass --output-dir <empty directory>");
  const directory = resolve(args[index + 1]);
  mkdirSync(directory, { recursive: true });
  return directory;
}

function smokeInstalledTarball(tarballPath) {
  const consumer = mkdtempSync(resolve(tmpdir(), "relay-release-consumer-"));
  try {
    writeFileSync(resolve(consumer, "package.json"), JSON.stringify({ name: "relay-release-consumer", private: true, type: "module" }, null, 2));
    exec("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: consumer });
    const program = [
      'import { RelayClient } from "@tuzuminami/relay";',
      'import { authAdapterFailure, createProductionRelayHttpServer } from "@tuzuminami/relay/server";',
      'import { listRelayMigrations, resolveRelayMigrationPath } from "@tuzuminami/relay/migrations";',
      'import { statSync } from "node:fs";',
      'const client = new RelayClient({ baseUrl: "https://relay.example.test", token: "token", tenantId: "tenant" });',
      'if (!(client instanceof RelayClient) || authAdapterFailure("AUTHENTICATION_REQUIRED").code !== "AUTHENTICATION_REQUIRED") process.exit(1);',
      'const migrations = listRelayMigrations();',
      'if (migrations.length !== 1 || !statSync(resolveRelayMigrationPath(migrations[0])).isFile()) process.exit(1);',
      'try { await createProductionRelayHttpServer(); process.exit(1); } catch (error) { if (error?.code !== "CONFIGURATION_INVALID") process.exit(1); }',
    ].join("\n");
    exec("node", ["--input-type=module", "--eval", program], { cwd: consumer });
  } finally {
    rmSync(consumer, { recursive: true, force: true });
  }
}

function writeEvidence(tarballPath, directory) {
  const sha256 = digest(readFileSync(tarballPath));
  const tarballName = basename(tarballPath);
  writeFileSync(resolve(directory, "SHA256SUMS"), `${sha256}  ${tarballName}\n`);

  const licenses = JSON.parse(exec("pnpm", ["licenses", "list", "--prod", "--json"]));
  const components = Object.entries(licenses).flatMap(([license, entries]) => entries.flatMap((entry) =>
    entry.versions.map((version) => ({ type: "library", name: entry.name, version, licenses: [{ license: { id: license } }] })),
  ));
  writeFileSync(resolve(directory, "sbom.cdx.json"), `${JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    serialNumber: `urn:uuid:${sha256.slice(0, 8)}-${sha256.slice(8, 12)}-${sha256.slice(12, 16)}-${sha256.slice(16, 20)}-${sha256.slice(20, 32)}`,
    version: 1,
    metadata: { component: { type: "application", name: packageJson.name, version: packageJson.version } },
    components,
  }, null, 2)}\n`);

  const commit = exec("git", ["rev-parse", "HEAD"]).trim();
  const repository = exec("git", ["remote", "get-url", "origin"]).trim().replace(/^git@github.com:/, "https://github.com/").replace(/\.git$/, "");
  const provenance = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ name: tarballName, digest: { sha256 } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/tuzuminami/relay/.github/workflows/release-evidence.yml",
        externalParameters: { package: packageJson.name, version: packageJson.version },
        internalParameters: {},
        resolvedDependencies: [{ uri: `git+${repository}@${commit}`, digest: { gitCommit: commit } }],
      },
      runDetails: {
        builder: { id: process.env.GITHUB_WORKFLOW_REF ?? "local" },
        metadata: { invocationId: process.env.GITHUB_RUN_ID ?? "local" },
      },
    },
  };
  writeFileSync(resolve(directory, "provenance.intoto.jsonl"), `${JSON.stringify(provenance)}\n`);
}

function exec(command, args, options = {}) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options });
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}
