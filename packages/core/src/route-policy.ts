import { RelayError } from "./errors.ts";
import type {
  Capability,
  ChatCompletionRequest,
  DataClassification,
  ModelRoute,
  ProviderConfig,
  RouteResolution,
} from "./types.ts";

const classificationRank: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export function resolveRoute(
  tenantId: string,
  request: Pick<ChatCompletionRequest, "purpose" | "dataClassification" | "requiredCapabilities" | "maxCostCents">,
  routes: readonly ModelRoute[],
  providers: ReadonlyMap<string, ProviderConfig>,
): RouteResolution {
  const candidates = routes.filter((route) => route.tenantId === tenantId && route.enabled && route.purpose === request.purpose);

  for (const route of candidates) {
    const provider = providers.get(route.providerId);
    const reasons = routeRejectionReasons(route, provider, request);
    if (provider !== undefined && reasons.length === 0) {
      return { allowed: true, reasonCodes: ["ROUTE_ALLOWED"], route, provider };
    }
  }

  return { allowed: false, reasonCodes: ["NO_COMPLIANT_ROUTE"] };
}

export function assertRouteAllowed(resolution: RouteResolution): asserts resolution is RouteResolution & {
  readonly route: ModelRoute;
  readonly provider: ProviderConfig;
} {
  if (!resolution.allowed || resolution.route === undefined || resolution.provider === undefined) {
    throw new RelayError("POLICY_BLOCKED", "No compliant route is available for this request.", 403, resolution.reasonCodes);
  }
}

function routeRejectionReasons(
  route: ModelRoute,
  provider: ProviderConfig | undefined,
  request: Pick<ChatCompletionRequest, "dataClassification" | "requiredCapabilities" | "maxCostCents">,
): readonly string[] {
  const reasons: string[] = [];
  if (provider === undefined || !provider.enabled) {
    reasons.push("PROVIDER_UNAVAILABLE");
  }
  if (route.maxCostCents > request.maxCostCents) {
    reasons.push("COST_CAP_EXCEEDED");
  }
  if (!classificationAllowed(request.dataClassification, route.allowedDataClassifications)) {
    reasons.push("DATA_CLASSIFICATION_DENIED");
  }
  for (const capability of request.requiredCapabilities) {
    if (!route.requiredCapabilities.includes(capability) || !providerHasCapability(provider, capability)) {
      reasons.push(`CAPABILITY_UNAVAILABLE:${capability}`);
    }
  }
  return reasons;
}

function classificationAllowed(
  requested: DataClassification,
  allowed: readonly DataClassification[],
): boolean {
  return allowed.some((candidate) => classificationRank[candidate] >= classificationRank[requested]);
}

function providerHasCapability(provider: ProviderConfig | undefined, capability: Capability): boolean {
  return provider !== undefined && provider.capabilities.includes(capability);
}
