// Hosted entry: `node dist/http.js`. PORT (default 2300) and RELAY_BASE_URL come from the environment.
import { startHostedServer } from "./hosted.js";
import { log } from "./log.js";

const port = Number(process.env.PORT || 2300);
startHostedServer({ port, baseUrl: process.env.RELAY_BASE_URL || undefined })
  .then(({ url }) => log("warning", "http_listening", { url, port }))
  .catch((e) => {
    log("error", "http_failed", { error: String(e) });
    process.exit(1);
  });
