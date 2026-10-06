// Unit-test harness: an in-memory MCP client over createRelayMcpServer with a scripted fetch (the SDK's only I/O).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createRelayMcpServer, type Credential, type ToolDef, type TransportKind } from "../../src/server.js";

export interface RecordedCall {
  method: string;
  /** Path + query, e.g. `/v2/tasks/direct:x?wait=30`. */
  url: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  /** Parsed JSON body, or the raw body when not JSON. */
  body: unknown;
}

export type Reply = { status?: number; json?: unknown; text?: string; headers?: Record<string, string> };
export type Route = { method: string; path: string | RegExp; reply: Reply | ((call: RecordedCall) => Reply | Promise<Reply>) };

export const TEST_BASE = "https://relay.test";

/** A fetch that answers from `routes` (first match wins) and records every call. Unmatched → 599, recorded. */
export function mockFetch(routes: Route[]) {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method ?? "GET").toUpperCase();
    let body: unknown = init.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* raw */
      }
    } else if (body instanceof Blob) {
      body = new Uint8Array(await body.arrayBuffer());
    } else if (body && typeof (body as ReadableStream).getReader === "function") {
      body = new Uint8Array(await new Response(body as ReadableStream).arrayBuffer());
    }
    const call: RecordedCall = { method, url: u.pathname + u.search, path: u.pathname, query: u.searchParams, headers: new Headers(init.headers), body };
    calls.push(call);
    const route = routes.find((r) => r.method === method && (typeof r.path === "string" ? r.path === u.pathname : r.path.test(u.pathname)));
    if (!route) return new Response(JSON.stringify({ detail: `unmocked ${method} ${u.pathname}` }), { status: 599 });
    const reply = typeof route.reply === "function" ? await route.reply(call) : route.reply;
    const text = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(text, { status: reply.status ?? 200, headers: { "content-type": "application/json", ...(reply.headers ?? {}) } });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

export async function connect(opts: { fetch: typeof fetch; tools?: ToolDef[]; credential?: Credential | null; transport?: TransportKind }) {
  const server = createRelayMcpServer({
    transport: opts.transport ?? "stdio",
    credential: opts.credential === undefined ? { apiKey: "relay_sk_unit_test_key" } : opts.credential,
    baseUrl: TEST_BASE,
    fetch: opts.fetch,
    tools: opts.tools,
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "unit", version: "0.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    client,
    call: (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** All text blocks of a result, joined. */
export const textOf = (r: CallToolResult) =>
  r.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");

/** A Relay error body as the API sends it. */
export const apiError = (status: number, code: string, message: string, requestId = "req_test_1"): Reply => ({
  status,
  json: { detail: message, error: { code, message, request_id: requestId } },
  headers: { "x-request-id": requestId },
});

/** The recorded POSTs, optionally to one path. */
export const posts = (calls: RecordedCall[], path?: string) => calls.filter((c) => c.method === "POST" && (!path || c.path === path));
