// Hosted Streamable HTTP server, stateless: a fresh McpServer + transport per request, the caller's credential read
// from that request's headers for that request only (never stored, never logged).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Credential } from "./context.js";
import { createRelayMcpServer, SERVER_INSTRUCTIONS, SERVER_NAME } from "./server.js";
import { renderMetrics } from "./metrics.js";
import { log } from "./log.js";
import { VERSION } from "./version.js";

export interface HostedOptions {
  port: number;
  host?: string;
  baseUrl?: string;
  /** Test seam: the fetch every SDK client uses. */
  fetch?: typeof fetch;
}

const BODY_MAX = 8 * 1024 * 1024; // a 4 MB base64 upload argument is ~5.4 MB of JSON
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, X-API-Key, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

/** `X-API-Key` wins (as on Relay); a Bearer value is a relay key when `relay_sk_`-prefixed, else a dashboard JWT. */
export function credentialFromHeaders(headers: IncomingMessage["headers"]): Credential | null {
  const key = headers["x-api-key"];
  const apiKey = (Array.isArray(key) ? key[0] : key)?.trim();
  if (apiKey) return { apiKey };
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? "")?.[1]?.trim();
  if (!bearer) return null;
  return bearer.startsWith("relay_sk_") ? { apiKey: bearer } : { jwt: bearer };
}

/** tools/list as a client sees it, read once through an in-memory client: the server card can never drift from it. */
export async function listTools(opts: { baseUrl?: string; fetch?: typeof fetch } = {}): Promise<Tool[]> {
  const server = createRelayMcpServer({ transport: "http", baseUrl: opts.baseUrl, fetch: opts.fetch });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "server-card", version: VERSION });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    return (await client.listTools()).tools;
  } finally {
    await client.close();
    await server.close();
  }
}

export function serverCard(tools: Tool[]) {
  return {
    name: SERVER_NAME,
    title: "Relay",
    version: VERSION,
    description: SERVER_INSTRUCTIONS,
    homepage: "https://relaygpu.com",
    transport: { type: "streamable-http", path: "/mcp" },
    authentication: {
      required: false,
      note: "Keyless tools answer without a credential; billed tools need one.",
      schemes: [
        { type: "header", name: "X-API-Key", description: "A Relay key (relay_sk_…)." },
        { type: "bearer", name: "Authorization", description: "A Relay key or a dashboard login JWT." },
      ],
    },
    tools,
  };
}

function send(res: ServerResponse, status: number, body: string, type: string) {
  res.writeHead(status, { "Content-Type": type, ...CORS_HEADERS }).end(body);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) {
        reject(Object.assign(new Error("body too large"), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("invalid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

const rpcError = (code: number, message: string) => JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null });

async function handleMcp(req: IncomingMessage, res: ServerResponse, opts: HostedOptions) {
  if (req.method !== "POST") {
    // Stateless: no standalone SSE stream and no session to delete.
    return send(res, 405, rpcError(-32000, "Method not allowed: this server is stateless, POST only."), "application/json");
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return send(res, status, rpcError(-32700, (e as Error).message), "application/json");
  }
  const server = createRelayMcpServer({ transport: "http", credential: credentialFromHeaders(req.headers), baseUrl: opts.baseUrl, fetch: opts.fetch });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  for (const [k, v] of Object.entries(CORS_HEADERS)) res.setHeader(k, v);
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function startHostedServer(opts: HostedOptions): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const card = JSON.stringify(serverCard(await listTools(opts)), null, 2);
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "OPTIONS") return void res.writeHead(204, CORS_HEADERS).end();
      if (path === "/mcp") return await handleMcp(req, res, opts);
      if (req.method !== "GET") return send(res, 405, '{"error":"method not allowed"}', "application/json");
      if (path === "/healthz") return send(res, 200, JSON.stringify({ status: "ok", version: VERSION }), "application/json");
      if (path === "/metrics") return send(res, 200, renderMetrics(), "text/plain; version=0.0.4");
      if (path === "/.well-known/mcp/server-card.json") return send(res, 200, card, "application/json");
      send(res, 404, '{"error":"not found"}', "application/json");
    } catch (e) {
      log("error", "http_request_failed", { path, error: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) send(res, 500, rpcError(-32603, "Internal server error"), "application/json");
    }
  });
  // A 45 s run_model must never be cut: request timeout well past it, keep-alive above common proxy idles.
  server.requestTimeout = 120_000;
  server.headersTimeout = 66_000;
  server.keepAliveTimeout = 65_000;
  await new Promise<void>((resolve) => server.listen(opts.port, opts.host ?? "0.0.0.0", resolve));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : opts.port;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
