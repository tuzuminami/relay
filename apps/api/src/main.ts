import { buildRuntimeService, createRelayHttpServer } from "./server.ts";
import { loadRuntimeAuthAdapter } from "./auth.ts";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const authAdapter = await loadRuntimeAuthAdapter();
const runtime = await buildRuntimeService();
const server = createRelayHttpServer(runtime.service, authAdapter, runtime.readiness);

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`relay api listening on http://127.0.0.1:${port}\n`);
});
