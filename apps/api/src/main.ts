import { createRelayHttpServer } from "./server.ts";
import { loadRuntimeAuthAdapter } from "./auth.ts";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const authAdapter = await loadRuntimeAuthAdapter();
const server = createRelayHttpServer(undefined, authAdapter);

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`relay api listening on http://127.0.0.1:${port}\n`);
});
