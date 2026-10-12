// Hosted entry: `node dist/http.js`. PORT (default 2300), RELAY_BASE_URL and the OAuth settings (OAUTH_ISSUER,
// MCP_RESOURCE_URL, OAUTH_MCP_CLIENT_SECRET) come from the environment, read once here.
import { startHostedServer } from "./hosted.js";
import { log } from "./log.js";
import { oauthConfigFromEnv } from "./oauth.js";

const port = Number(process.env.PORT || 2300);
const oauth = oauthConfigFromEnv();
if (oauth && !oauth.clientSecret) log("error", "oauth_client_secret_missing", { issuer: oauth.issuer });
startHostedServer({ port, baseUrl: process.env.RELAY_BASE_URL || undefined, oauth })
  .then(({ server, url, close }) => {
    log("warning", "http_listening", { url, port, oauth: oauth ? { issuer: oauth.issuer, resource: oauth.resource } : "off" });
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
