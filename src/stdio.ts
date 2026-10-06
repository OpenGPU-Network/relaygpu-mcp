// stdio entry (the package bin): `npx -y @relaygpu/mcp`. Credential from RELAY_API_KEY, base URL from RELAY_BASE_URL.
// stdout carries MCP frames only; everything else goes to stderr (src/log.ts).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRelayMcpServer } from "./server.js";
import { log } from "./log.js";

const apiKey = process.env.RELAY_API_KEY || undefined;
const server = createRelayMcpServer({
  transport: "stdio",
  credential: apiKey ? { apiKey } : null,
  baseUrl: process.env.RELAY_BASE_URL || undefined,
});

server
  .connect(new StdioServerTransport())
  .then(() => log("info", "stdio_ready", { credential: apiKey ? "set" : "none" }))
  .catch((e) => {
    log("error", "stdio_failed", { error: String(e) });
    process.exit(1);
  });
