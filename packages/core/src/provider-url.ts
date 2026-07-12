import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { RelayError } from "./errors.ts";

export interface ProviderEgressPolicy {
  readonly production: boolean;
  readonly allowedOrigins: readonly string[];
}

export interface ProviderAddressResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export const systemProviderAddressResolver: ProviderAddressResolver = {
  async resolve(hostname) {
    const [ipv4, ipv6] = await Promise.all([
      resolve4(hostname).catch(() => []),
      resolve6(hostname).catch(() => []),
    ]);
    return [...ipv4, ...ipv6];
  },
};

export type RuntimeMode = "development" | "test" | "production";
export type RuntimeAuthMode = "development" | "test" | "production";

export function runtimeModeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeMode {
  const mode = environment.NODE_ENV ?? "development";
  if (mode === "development" || mode === "test" || mode === "production") {
    return mode;
  }
  throw new RelayError("CONFIGURATION_INVALID", "NODE_ENV must be development, test, or production.", 503);
}

export function runtimeAuthModeFromEnvironment(environment: NodeJS.ProcessEnv = process.env): RuntimeAuthMode {
  const mode = environment.RELAY_AUTH_ADAPTER ?? "development";
  if (mode === "development" || mode === "test" || mode === "production") {
    return mode;
  }
  throw new RelayError("CONFIGURATION_INVALID", "RELAY_AUTH_ADAPTER must be development, test, or production.", 503);
}

export function isProductionRuntime(environment: NodeJS.ProcessEnv = process.env): boolean {
  return runtimeModeFromEnvironment(environment) === "production" || runtimeAuthModeFromEnvironment(environment) === "production";
}

export function providerBaseUrlRejectionReasons(value: string, policy: ProviderEgressPolicy): readonly string[] {
  let origin: string;
  let hostname: string;
  try {
    const url = new URL(value);
    origin = canonicalProviderOrigin(url);
    hostname = url.hostname;
    if (url.username.length > 0 || url.password.length > 0) {
      return ["BASE_URL_CREDENTIALS_FORBIDDEN"];
    }
  } catch {
    return ["BASE_URL_INVALID"];
  }

  const reasons: string[] = [];
  if (isBlockedHostname(hostname)) {
    reasons.push("BASE_URL_EGRESS_BLOCKED");
  }
  if (policy.production && !origin.startsWith("https://")) {
    reasons.push("BASE_URL_HTTPS_REQUIRED");
  }
  if (policy.production && !policy.allowedOrigins.includes(origin)) {
    reasons.push("BASE_URL_ORIGIN_NOT_ALLOWED");
  }
  return reasons;
}

export async function providerAddressRejectionReasons(value: string, resolver: ProviderAddressResolver): Promise<readonly string[]> {
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    return ["BASE_URL_INVALID"];
  }
  const addresses = await resolver.resolve(hostname);
  return providerAddressRejectionReasonsForAddresses(addresses);
}

export function providerAddressRejectionReasonsForAddresses(addresses: readonly string[]): readonly string[] {
  if (addresses.length === 0) {
    return ["BASE_URL_DNS_UNRESOLVED"];
  }
  return addresses.some((address) => !isPublicAddress(address)) ? ["BASE_URL_DNS_PRIVATE"] : [];
}

export function canonicalProviderOrigin(value: string | URL): string {
  const url = typeof value === "string" ? new URL(value) : new URL(value.href);
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return url.origin;
}

export function allowedOriginsFromEnvironment(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) {
    return [];
  }
  const origins: string[] = [];
  for (const rawOrigin of value.split(",")) {
    try {
      const url = new URL(rawOrigin.trim());
      if (url.protocol !== "https:" || url.origin === "null" || url.username.length > 0 || url.password.length > 0 || url.pathname !== "/" || url.search.length > 0 || url.hash.length > 0) {
        continue;
      }
      origins.push(canonicalProviderOrigin(url));
    } catch {
      // Invalid values cannot become an allow rule.
    }
  }
  return [...new Set(origins)];
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized === "metadata" || normalized.endsWith(".metadata") || normalized === "metadata.google.internal" || normalized.endsWith(".metadata.google.internal")) {
    return true;
  }
  if (normalized.startsWith("[") && normalized.endsWith("]")) {
    return true;
  }
  if (isIP(normalized) !== 0 || /^\d+$/.test(normalized)) {
    return true;
  }
  return false;
}

function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const parts = address.split(".").map(Number);
    const a = parts[0] ?? -1;
    const b = parts[1] ?? -1;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 192 && b === 2) || (a === 198 && b === 51) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    const mappedIpv4 = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
    if (mappedIpv4 !== undefined) {
      return false;
    }
    if (normalized.startsWith("2001:db8:")) {
      return false;
    }
    const firstHextet = Number.parseInt(normalized.split(":", 1)[0] ?? "", 16);
    // IPv6 global-unicast is 2000::/3. This excludes unspecified, loopback,
    // link/site-local, unique-local, multicast, and other non-global ranges.
    return Number.isInteger(firstHextet) && firstHextet >= 0x2000 && firstHextet <= 0x3fff;
  }
  return false;
}
