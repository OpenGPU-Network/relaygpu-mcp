import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { AGENT_SETUP_PATH, credentialFromHeaders, startHostedServer } from "../../src/hosted.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { mockFetch, TEST_BASE, textOf } from "../helpers/harness.js";

const KEY = "relay_sk_hosted_unit_key_42";
const m = mockFetch([
  { method: "GET", path: "/v2/customer/credits", reply: { json: { balance: 12.5 } } },
  { method: "GET", path: "/v2/models", reply: { json: { auto: { image: [{ name: "Qwen/qwen-image", tag: "text-to-image" }] }, direct: {}, opengpu: {} } } },
]);
let hosted: Awaited<ReturnType<typeof startHostedServer>>;

beforeAll(async () => {
  hosted = await startHostedServer({ port: 0, host: "127.0.0.1", baseUrl: TEST_BASE, fetch: m.fetch });
});
afterAll(() => hosted.close());

async function mcp(headers: Record<string, string> = {}) {
  const client = new Client({ name: "hosted-unit", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(hosted.url + "/mcp"), { requestInit: { headers } }));
  return client;
}

describe("credentialFromHeaders", () => {
  it("X-API-Key wins over Bearer; a relay_sk_ Bearer is a key, anything else a JWT", () => {
    expect(credentialFromHeaders({ "x-api-key": "relay_sk_a", authorization: "Bearer relay_sk_b" })).toEqual({ apiKey: "relay_sk_a" });
    expect(credentialFromHeaders({ authorization: "Bearer relay_sk_b" })).toEqual({ apiKey: "relay_sk_b" });
    expect(credentialFromHeaders({ authorization: "Bearer aaa.bbb.ccc" })).toEqual({ jwt: "aaa.bbb.ccc" });
    expect(credentialFromHeaders({})).toBeNull();
  });
});

describe("hosted server", () => {
  it("F2 a body above the limit gets a 413 naming the limit, never a reset (Content-Length and chunked)", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "upload_file", arguments: { base64: "A".repeat(7 * 1024 * 1024) } } });
    const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
    const sized = await fetch(hosted.url + "/mcp", { method: "POST", headers, body: big });
    expect(sized.status).toBe(413);
    const { error } = await sized.json();
    expect(error.message).toMatch(/limit is 6\.3 MB.*4 MB/);
    // No Content-Length: the limit trips while streaming.
    const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const chunked = await fetch(hosted.url + "/mcp", { method: "POST", headers, body: stream, duplex: "half" } as RequestInit);
    expect(chunked.status).toBe(413);
    // The server still answers the next request on a fresh connection.
    expect((await fetch(hosted.url + "/healthz")).status).toBe(200);
  });

  it("A9 /healthz answers status and version", async () => {
    const r = await fetch(hosted.url + "/healthz");
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok", version: expect.any(String) });
  });

  it("A9 F3 tools/list has exactly 14 tools and the server card equals it", async () => {
    const client = await mcp();
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(14);
    expect(ALL_TOOLS).toHaveLength(14);
    const card = await (await fetch(hosted.url + "/.well-known/mcp/server-card.json")).json();
    expect(card.tools).toEqual(tools);
    await client.close();
  });

  it("A9 /metrics carries both series after a call", async () => {
    const client = await mcp();
    await client.callTool({ name: "search_models", arguments: {} });
    await client.close();
    const text = await (await fetch(hosted.url + "/metrics")).text();
    expect(text).toMatch(/mcp_tool_calls_total\{tool="search_models",outcome="(ok|error)"\} \d+/);
    expect(text).toMatch(/mcp_tool_seconds_count\{tool="search_models"\} \d+/);
  });

  it("A2 N2 the credential is per request: a keyed call, then a keyless one, never shares it", async () => {
    const keyed = await mcp({ "X-API-Key": KEY });
    const ok = (await keyed.callTool({ name: "get_credits", arguments: {} })) as CallToolResult;
    expect(ok.isError).toBeFalsy();
    await keyed.close();
    const before = m.calls.length;
    const anon = await mcp();
    const r = (await anon.callTool({ name: "get_credits", arguments: {} })) as CallToolResult;
    await anon.close();
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("X-API-Key");
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(m.calls.length).toBe(before); // refused locally, never sent as a guest
    expect(m.calls.filter((c) => c.path === "/v2/customer/credits").every((c) => c.headers.get("x-api-key") === KEY)).toBe(true);
    expect(JSON.stringify(ok)).not.toContain(KEY);
  });

  it("stateless: GET /mcp is 405, no session id is issued, CORS exposes Mcp-Session-Id", async () => {
    expect((await fetch(hosted.url + "/mcp")).status).toBe(405);
    const r = await fetch(hosted.url + "/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } }),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeNull();
    expect(r.headers.get("access-control-expose-headers")).toContain("Mcp-Session-Id");
    const pre = await fetch(hosted.url + "/mcp", { method: "OPTIONS" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-API-Key");
  });

  it("D9 request timeout is ≥ 90 s", () => {
    expect(hosted.server.requestTimeout).toBeGreaterThanOrEqual(90_000);
  });

  it("0.1.7 A12 GET /agent-setup.md: the page as markdown, cached 5 min, keyless, the same body for any Accept", async () => {
    const page = readFileSync(new URL("../../agent-setup.md", import.meta.url), "utf8");
    for (const accept of [undefined, "application/json"]) {
      const r = await fetch(hosted.url + AGENT_SETUP_PATH, accept ? { headers: { Accept: accept } } : {});
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
      expect(r.headers.get("cache-control")).toBe("public, max-age=300");
      const text = await r.text();
      expect(text).toBe(page);
      expect(text).toContain("## Claude Code");
    }
  });
});
