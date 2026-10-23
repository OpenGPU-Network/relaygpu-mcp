// 0.1.8: catalog lookups run as the caller's account (ctx.reader); polls and the public catalog stay keyless.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startHostedServer } from "../../src/hosted.js";
import { apiError, connect, mockFetch, posts, textOf, TEST_BASE, type RecordedCall, type Route } from "../helpers/harness.js";
import { jsonOf, modelDetail, modelPath, PRICING } from "../fixtures/relay.js";

const PRIVATE = "acme/private-model";
const ROUTE = "/v2/private/generate";
const TASK = "direct:7b1e2c4a-0000-4000-8000-000000000002";
const KEY = "relay_sk_keyed_lookup_unit";
const JWT = "aaa.bbb.ccc";

const row = { name: PRIVATE, display_name: "private-model", tag: "text-to-text", store_output_supported: false, endpoint: { method: "POST", path: ROUTE, operation_id: "op", model_in_body: true, async_default: false, streams: false } };
const keyed = (c: RecordedCall) => c.headers.get("x-api-key") !== null || c.headers.get("authorization") !== null;
const PUBLIC_LIST = { auto: { chat: [] }, model_restrictions_per_tier: {} };
const PRIVATE_LIST = { auto: { chat: [row] }, model_restrictions_per_tier: {} };
const PRIVATE_PRICING = { ...PRICING, pricing: [...PRICING.pricing, { mode: "direct", model: `chat.${PRIVATE}`, billing_type: "per_token", per_1m_input_tokens: 1, per_1m_output_tokens: 2 }] };

/** A catalog that answers the private model only to a call carrying a credential. */
const routes = (): Route[] => [
  { method: "GET", path: "/v2/models", reply: (c) => ({ json: keyed(c) ? PRIVATE_LIST : PUBLIC_LIST }) },
  { method: "GET", path: modelPath(PRIVATE), reply: (c) => (keyed(c) ? { json: modelDetail(PRIVATE, { tag: "text-to-text", endpoint: { path: ROUTE } }) } : apiError(404, "MODEL_NOT_FOUND", `Model '${PRIVATE}' not found`)) },
  { method: "GET", path: "/v2/pricing", reply: (c) => ({ json: keyed(c) ? PRIVATE_PRICING : PRICING }) },
  { method: "POST", path: ROUTE, reply: { json: { choices: [{ message: { content: "hi" } }] } } },
  { method: "GET", path: /^\/v2\/tasks\//, reply: { json: { status: "completed", elapsed_seconds: 1, result: {} } } },
];

describe("0.1.8 catalog lookups run as the caller's account", () => {
  it("with an API key every catalog GET carries X-API-Key and the private model is visible", async () => {
    const m = mockFetch(routes());
    const s = await connect({ fetch: m.fetch, credential: { apiKey: KEY } });
    expect(jsonOf(await s.call("search_models", { query: "private" })).models.map((x: { name: string }) => x.name)).toEqual([PRIVATE]);
    expect(jsonOf(await s.call("get_model", { model: PRIVATE })).name).toBe(PRIVATE);
    expect(jsonOf(await s.call("get_pricing", { model: PRIVATE })).total_count).toBe(1);
    expect(jsonOf(await s.call("estimate_cost", { model: PRIVATE, usage: { input_tokens: 1_000_000 } })).usd).toBeGreaterThan(0);
    const catalogGets = m.calls.filter((c) => c.method === "GET");
    expect(catalogGets.length).toBeGreaterThan(0);
    expect(catalogGets.every((c) => c.headers.get("x-api-key") === KEY)).toBe(true);
    await s.close();
  });

  it("with a JWT the catalog GETs carry Authorization: Bearer", async () => {
    const m = mockFetch(routes());
    const s = await connect({ fetch: m.fetch, credential: { jwt: JWT } });
    expect(jsonOf(await s.call("get_model", { model: PRIVATE })).name).toBe(PRIVATE);
    await s.call("get_pricing", {});
    expect(m.calls.every((c) => c.headers.get("authorization") === `Bearer ${JWT}` && c.headers.get("x-api-key") === null)).toBe(true);
    await s.close();
  });

  it("without a credential no catalog GET carries one, and the private model does not exist", async () => {
    const m = mockFetch(routes());
    const s = await connect({ fetch: m.fetch, credential: null });
    expect(jsonOf(await s.call("search_models", { query: "private" })).total).toBe(0);
    const r = await s.call("get_model", { model: PRIVATE });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("code: MODEL_NOT_FOUND");
    await s.call("get_pricing", { model: PRIVATE });
    await s.call("estimate_cost", { model: "Qwen/qwen-image", usage: {} });
    expect(m.calls.some(keyed)).toBe(false);
    await s.close();
  });

  it("run_model resolves a model the keyless catalog 404s and reaches the POST; the task poll stays keyless", async () => {
    const m = mockFetch(routes());
    const s = await connect({ fetch: m.fetch, credential: { apiKey: KEY } });
    const r = await s.call("run_model", { model: PRIVATE, input: { messages: [{ role: "user", content: "hi" }] } });
    expect(r.isError).toBeFalsy();
    expect(m.calls.find((c) => c.path === modelPath(PRIVATE))!.headers.get("x-api-key")).toBe(KEY);
    expect(posts(m.calls, ROUTE)).toHaveLength(1);
    const t = await s.call("check_task", { task_id: TASK, wait_seconds: 0 });
    expect(t.isError).toBeFalsy();
    const polls = m.calls.filter((c) => c.path.startsWith("/v2/tasks/"));
    expect(polls.length).toBeGreaterThan(0);
    expect(polls.every((c) => !keyed(c))).toBe(true);
    await s.close();
  });

  it("workflow listing stays keyless", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/workflows", reply: { json: { templates: [] } } }]);
    const s = await connect({ fetch: m.fetch, credential: { apiKey: KEY } });
    await s.call("list_workflows", {});
    expect(m.calls.filter((c) => c.path === "/v2/workflows").every((c) => !keyed(c))).toBe(true);
    await s.close();
  });

  it("tool text says a credential gives the account's view", async () => {
    const s = await connect({ fetch: mockFetch([]).fetch, credential: null });
    const { tools } = await s.client.listTools();
    for (const n of ["search_models", "get_model", "get_pricing", "estimate_cost"]) {
      expect(tools.find((t) => t.name === n)!.description).toMatch(/with a credential[^.]*account's view/i);
    }
    await s.close();
  });
});

describe("0.1.8 hosted: a client per request, no cache shared between credentials", () => {
  const m = mockFetch([
    { method: "GET", path: modelPath(PRIVATE), reply: (c) => ({ json: modelDetail(PRIVATE, { tag: c.headers.get("x-api-key") === "relay_sk_a" ? "tag-a" : "tag-b", endpoint: { path: ROUTE } }) }) },
  ]);
  let hosted: Awaited<ReturnType<typeof startHostedServer>>;
  beforeAll(async () => {
    hosted = await startHostedServer({ port: 0, host: "127.0.0.1", baseUrl: TEST_BASE, fetch: m.fetch });
  });
  afterAll(() => hosted.close());

  async function getModel(key: string) {
    const c = new Client({ name: "u", version: "0.0.0" });
    await c.connect(new StreamableHTTPClientTransport(new URL(hosted.url + "/mcp"), { requestInit: { headers: { "X-API-Key": key } } }));
    const r = (await c.callTool({ name: "get_model", arguments: { model: PRIVATE } })) as CallToolResult;
    await c.close();
    return jsonOf(r);
  }

  it("two credentials in two requests get two different answers", async () => {
    expect((await getModel("relay_sk_a")).tag).toBe("tag-a");
    expect((await getModel("relay_sk_b")).tag).toBe("tag-b");
    expect((await getModel("relay_sk_a")).tag).toBe("tag-a");
    const sent = m.calls.filter((c) => c.path === modelPath(PRIVATE)).map((c) => c.headers.get("x-api-key"));
    expect(sent).toEqual(["relay_sk_a", "relay_sk_b", "relay_sk_a"]);
  });
});
