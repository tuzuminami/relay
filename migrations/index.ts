import { fileURLToPath } from "node:url";

const migrationNames = ["0001_initial.sql"] as const;

export type RelayMigrationName = (typeof migrationNames)[number];

export function listRelayMigrations(): readonly RelayMigrationName[] {
  return [...migrationNames];
}

export function resolveRelayMigrationPath(name: RelayMigrationName): string {
  if (!(migrationNames as readonly string[]).includes(name)) {
    throw new TypeError("Unknown RELAY migration.");
  }
  return fileURLToPath(new URL(`../../db/migrations/${name}`, import.meta.url));
}
