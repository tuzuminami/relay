import { loadRuntimeAuthAdapter } from "../../apps/api/src/auth.ts";
import { buildDefaultService, createRelayHttpServer } from "../../apps/api/src/server.ts";
import { RelayError } from "../core/src/errors.ts";
import { isProductionRuntime } from "../core/src/provider-url.ts";

export { authAdapterFailure, type AuthAdapter, type AuthAdapterFailure, type AuthIdentity } from "../../apps/api/src/auth.ts";

export async function createProductionRelayHttpServer() {
  if (!isProductionRuntime()) {
    throw new RelayError("CONFIGURATION_INVALID", "The published server entrypoint requires production runtime configuration.", 503);
  }
  return createRelayHttpServer(buildDefaultService(), await loadRuntimeAuthAdapter());
}
