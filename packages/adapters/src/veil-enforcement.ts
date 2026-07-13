import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet } from "jose";
import { RelayError } from "../../core/src/errors.ts";
import type { VeilDecisionReplayStore, VeilDecisionVerifier } from "../../core/src/ports.ts";
import type { VerifiedVeilDecision } from "../../core/src/types.ts";

// This is the protocol default VEIL must use when issuing RELAY enforcement tokens.
export const RELAY_VEIL_ENFORCEMENT_AUDIENCE = "relay-api";

export function createVeilDecisionVerifier({ issuer, audience, jwks }: { readonly issuer: string; readonly audience: string; readonly jwks: JSONWebKeySet }): VeilDecisionVerifier {
  return createVerifier({ issuer, audience, keySet: createLocalJWKSet(jwks) });
}

export function createRemoteVeilDecisionVerifier({ issuer, audience, jwksUrl }: { readonly issuer: string; readonly audience: string; readonly jwksUrl: string }): VeilDecisionVerifier {
  return createVerifier({
    issuer,
    audience,
    keySet: createRemoteJWKSet(new URL(jwksUrl), {
      timeoutDuration: 5_000,
      cooldownDuration: 30_000,
      cacheMaxAge: 600_000,
    }),
  });
}

function createVerifier({ issuer, audience, keySet }: {
  readonly issuer: string;
  readonly audience: string;
  readonly keySet: ReturnType<typeof createLocalJWKSet> | ReturnType<typeof createRemoteJWKSet>;
}): VeilDecisionVerifier {
  return {
    async verify(input) {
      try {
        const verified = await jwtVerify(input.token, keySet, {
          issuer,
          audience,
          algorithms: ["EdDSA"],
          currentDate: input.now,
          requiredClaims: ["exp", "iat", "jti"],
          maxTokenAge: "5m",
        });
        const payload = verified.payload;
        const decisionId = requiredString(payload.decision_id);
        const jti = requiredString(payload.jti);
        const tenantId = requiredString(payload.tenant_id);
        const action = requiredString(payload.action);
        const requestedAction = requiredString(payload.requested_action);
        const inputHash = requiredString(payload.input_hash);
        const policyHash = requiredString(payload.policy_hash);
        if (jti !== decisionId || action !== "ALLOW" || tenantId !== input.tenantId || requestedAction !== input.requestedAction || inputHash !== input.inputHash || !/^[a-f0-9]{64}$/.test(policyHash) || (requestedAction !== "model_call" && requestedAction !== "tool_call") || payload.exp === undefined) throw new Error("claim mismatch");
        return { decisionId, tenantId, requestedAction, inputHash, policyHash, expiresAt: new Date(payload.exp * 1000) } as VerifiedVeilDecision;
      } catch {
        throw new RelayError("VEIL_DECISION_INVALID", "VEIL decision cannot authorize this provider request.", 403);
      }
    }
  };
}

export class InMemoryVeilDecisionReplayStore implements VeilDecisionReplayStore {
  private readonly claims = new Map<string, number>();

  async claim(input: { readonly tenantId: string; readonly decisionId: string; readonly expiresAt: Date; readonly now: Date }): Promise<boolean> {
    for (const [key, expiresAt] of this.claims) if (expiresAt <= input.now.getTime()) this.claims.delete(key);
    const key = `${input.tenantId}\u0000${input.decisionId}`;
    if (this.claims.has(key)) return false;
    this.claims.set(key, input.expiresAt.getTime());
    return true;
  }
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw new Error("invalid claim");
  return value;
}
