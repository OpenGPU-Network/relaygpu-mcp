// A9 (F9): /healthz, /metrics (both series after one tool call), the server card equals tools/list (14).
// Keyless. The Dockerfile/container half of A9 is the lead's.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HAS_BASE, TOOL_NAMES, mcpHttp, startHosted, type McpHandle } from "./harness.js";

describe.skipIf(!HAS_BASE)("A9 hosted ops", () => {
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let mcp: McpHandle;

  beforeAll(async () => {
    hosted = await startHosted();
    mcp = await mcpHttp(hosted.url);
  });
  afterAll(async () => {
    await mcp?.close();
    await hosted?.close();
  });

  it("A9 GET /healthz → {status: ok, version}", async () => {
    const res = await fetch(`${hosted.url}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string; version?: string };
    expect(body.status).toBe("ok");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("A9 GET /metrics carries mcp_tool_calls_total and mcp_tool_seconds after one tool call", async () => {
    const r = await mcp.call("search_docs", { query: "idempotency key" });
    expect(r.isError).toBeFalsy();
    const res = await fetch(`${hosted.url}/metrics`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("mcp_tool_calls_total");
    expect(text).toContain("mcp_tool_seconds");
    expect(text).toMatch(/mcp_tool_calls_total\{[^}]*tool="search_docs"/);
  });

  it("A9 the server card lists the 14 tools and equals tools/list", async () => {
    const res = await fetch(`${hosted.url}/.well-known/mcp/server-card.json`);
    expect(res.status).toBe(200);
    const card = (await res.json()) as { tools: { name: string }[] };
    const { tools } = await mcp.client.listTools();
    expect(card.tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect(card.tools).toEqual(JSON.parse(JSON.stringify(tools)));
  });
});
