// Hosted entry: `node dist/http.js`. PORT (default 2300) and RELAY_BASE_URL come from the environment.
import { startHostedServer } from "./hosted.js";
import { log } from "./log.js";

const port = Number(process.env.PORT || 2300);
startHostedServer({ port, baseUrl: process.env.RELAY_BASE_URL || undefined })
  .then(({ server, url, close }) => {
    log("warning", "http_listening", { url, port });
    // Rolling deploys send SIGTERM: stop accepting, let in-flight requests (up to a 45 s run_model) finish, exit.
    // As PID 1 in the container, Node would otherwise ignore SIGTERM until the runtime's kill.
    const drain = (signal: string) => {
      log("warning", "http_draining", { signal });
      server.closeIdleConnections();
      void close().then(() => process.exit(0));
    };
    process.once("SIGTERM", () => drain("SIGTERM"));
    process.once("SIGINT", () => drain("SIGINT"));
  })
  .catch((e) => {
    log("error", "http_failed", { error: String(e) });
    process.exit(1);
  });
