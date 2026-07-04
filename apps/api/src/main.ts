import { createRelayHttpServer } from "./server.ts";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
const server = createRelayHttpServer();

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`relay api listening on http://127.0.0.1:${port}\n`);
});
