// Hosted Streamable HTTP server, stateless: a fresh McpServer + transport per request, the caller's credential read
// from that request's headers for that request only (never stored, never logged). With OAuth on, an access token is
// swapped for a short-lived Relay credential held in memory per token hash (src/oauth.ts).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Credential } from "./context.js";
import { createRelayMcpServer, SERVER_INSTRUCTIONS, SERVER_NAME } from "./server.js";
import { renderMetrics } from "./metrics.js";
import { log } from "./log.js";
import { createOAuth, PRM_PATH, SCOPE, type OAuth, type OAuthConfig } from "./oauth.js";
import { MAX_BASE64_BYTES } from "./tools/files.js";
import { VERSION } from "./version.js";
import AGENT_SETUP from "../agent-setup.md";

export interface HostedOptions {
  port: number;
  host?: string;
  baseUrl?: string;
  /** Test seam: the fetch every SDK client uses. */
  fetch?: typeof fetch;
  /** "Connect Relay" (OAuth). Unset = off: no protected-resource metadata, keyless calls answer as before. */
  oauth?: OAuthConfig | null;
}

// The largest upload_file base64 argument, encoded, plus 1 MB of JSON-RPC headroom.
const BODY_MAX = Math.ceil((MAX_BASE64_BYTES * 4) / 3) + 1024 * 1024;
// An oversized body is still read to its end (discarded) so the 413 reaches the client instead of a reset;
// past this much the connection is cut.
const DRAIN_MAX = 64 * 1024 * 1024;
const MB = 1024 * 1024;
const TOO_LARGE =
  `Request body too large: the limit is ${(BODY_MAX / MB).toFixed(1)} MB, which fits an upload_file base64 ` +
  `argument of ${MAX_BASE64_BYTES / MB} MB. For a bigger file pass a public url to upload_file instead.`;
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, X-API-Key, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID",
  "Access-Control-Expose-Headers": "Mcp-Session-Id, WWW-Authenticate",
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

const HEADER_SCHEMES = [
  { type: "header", name: "X-API-Key", description: "A Relay key (relay_sk_…)." },
  { type: "bearer", name: "Authorization", description: "A Relay key or a dashboard login JWT." },
];

function authentication(oauth: OAuth | null) {
  if (!oauth) return { required: false, note: "Keyless tools answer without a credential (the public catalog; with one, the catalog tools answer your account's); billed tools need one.", schemes: HEADER_SCHEMES };
  return {
    required: true,
    note: "Every request needs a credential: sign in with OAuth (Connect Relay), or send a Relay key header.",
    schemes: [
      {
        type: "oauth2",
        resource_metadata: oauth.prmUrl,
        authorization_servers: [oauth.issuer],
        scopes: [SCOPE],
        description: "Connect Relay: sign in to Relay and approve the app.",
      },
      ...HEADER_SCHEMES,
    ],
  };
}

function serverCard(tools: Tool[], oauth: OAuth | null) {
  return {
    name: SERVER_NAME,
    title: "Relay",
    version: VERSION,
    description: SERVER_INSTRUCTIONS,
    homepage: "https://relaygpu.com",
    transport: { type: "streamable-http", path: "/mcp" },
    authentication: authentication(oauth),
    tools,
  };
}

function send(res: ServerResponse, status: number, body: string, type: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { "Content-Type": type, ...CORS_HEADERS, ...headers }).end(body);
}

/** The agent-setup page (F10): keyless, outside the OAuth-guarded /mcp, one body for every Accept. */
export const AGENT_SETUP_PATH = "/agent-setup.md";
const AGENT_SETUP_CACHE = { "Cache-Control": "public, max-age=300" };

const sendJson = (res: ServerResponse, status: number, body: string, headers?: Record<string, string>) =>
  send(res, status, body, "application/json", headers);

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = Number(req.headers["content-length"]) > BODY_MAX;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > BODY_MAX) tooLarge = true;
      if (!tooLarge) chunks.push(c);
      else if (size > DRAIN_MAX) req.destroy();
    });
    req.on("end", () => {
      if (tooLarge) return reject(Object.assign(new Error(TOO_LARGE), { status: 413 }));
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

const SIGN_IN =
  "Authentication required: connect with OAuth (Connect Relay), or send X-API-Key: relay_sk_… or Authorization: Bearer <Relay key>.";
const SIGN_IN_AGAIN = "The access token is invalid or expired, or the connection was revoked: sign in again.";
const AS_DOWN = "Relay's authorization server could not be reached to accept this sign-in; try again shortly.";

/**
 * The credential this request runs with, or false when an answer was already sent. With OAuth on: no credential →
 * 401 challenge (D-O3); an access token from our issuer → verified and exchanged for a Relay credential. Every other
 * credential passes through unchanged.
 */
async function authorize(req: IncomingMessage, res: ServerResponse, oauth: OAuth | null): Promise<Credential | null | false> {
  const credential = credentialFromHeaders(req.headers);
  if (!oauth) return credential;
  if (!credential) {
    sendJson(res, 401, rpcError(-32001, SIGN_IN), { "WWW-Authenticate": `Bearer resource_metadata="${oauth.prmUrl}", scope="${SCOPE}"` });
    return false;
  }
  const r = credential.jwt ? await oauth.resolve(credential.jwt) : null;
  if (!r) return credential; // a key, or a JWT that is not our access token: unchanged
  if (r.ok) return { jwt: r.jwt };
  if (r.status === 401) {
    sendJson(res, 401, rpcError(-32001, SIGN_IN_AGAIN), {
      "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${oauth.prmUrl}"`,
    });
  } else {
    sendJson(res, 503, rpcError(-32000, AS_DOWN), { "Retry-After": "5" });
  }
  return false;
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, opts: HostedOptions, oauth: OAuth | null) {
  // Auth first, even for a GET: a client probing /mcp must meet the 401 challenge to discover OAuth.
  const credential = await authorize(req, res, oauth);
  if (credential === false) return;
  if (req.method !== "POST") {
    // Stateless: no standalone SSE stream and no session to delete.
    return sendJson(res, 405, rpcError(-32000, "Method not allowed: this server is stateless, POST only."));
  }
  let body: unknown;
  try {
    body = await readJson(req);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 400;
    return sendJson(res, status, rpcError(status === 413 ? -32600 : -32700, (e as Error).message));
  }
  const server = createRelayMcpServer({ transport: "http", credential, baseUrl: opts.baseUrl, fetch: opts.fetch });
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
  const oauth = opts.oauth ? createOAuth(opts.oauth) : null;
  const card = JSON.stringify(serverCard(await listTools(opts), oauth), null, 2);
  const server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    try {
      if (req.method === "OPTIONS") return void res.writeHead(204, CORS_HEADERS).end();
      if (path === "/mcp") return await handleMcp(req, res, opts, oauth);
      if (req.method !== "GET") return sendJson(res, 405, '{"error":"method not allowed"}');
      if (path === "/healthz") return sendJson(res, 200, JSON.stringify({ status: "ok", version: VERSION }));
      if (path === "/metrics") return send(res, 200, renderMetrics(), "text/plain; version=0.0.4");
      if (path === "/.well-known/mcp/server-card.json") return sendJson(res, 200, card);
      if (path === AGENT_SETUP_PATH) return send(res, 200, AGENT_SETUP, "text/markdown; charset=utf-8", AGENT_SETUP_CACHE);
      if (oauth && (path === PRM_PATH || path === PRM_PATH + "/mcp")) return sendJson(res, 200, oauth.prm);
      sendJson(res, 404, '{"error":"not found"}');
    } catch (e) {
      log("error", "http_request_failed", { path, error: e instanceof Error ? e.name : "unknown" });
      if (!res.headersSent) sendJson(res, 500, rpcError(-32603, "Internal server error"));
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
