import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineTool, jsonResult } from "../../src/context.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { connect, mockFetch, textOf, apiError } from "../helpers/harness.js";

const ping = defineTool({
  name: "ping_billed",
  title: "Ping",
  description: "test tool",
  inputSchema: { echo: z.string().describe("echo") },
  async handler(args, ctx) {
    const data = await ctx.client().request("GET", "/v2/customer/credits");
    return jsonResult({ echo: args.echo, data });
  },
});

describe("server core", () => {
  it("billed tool without a credential: MISSING_CREDENTIALS naming X-API-Key on hosted, zero requests", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: [ping], credential: null, transport: "http" });
    const r = await s.call("ping_billed", { echo: "x" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(textOf(r)).toContain("X-API-Key");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("stdio hint names RELAY_API_KEY", async () => {
    const s = await connect({ fetch: mockFetch([]).fetch, tools: [ping], credential: null, transport: "stdio" });
    expect(textOf(await s.call("ping_billed", { echo: "x" }))).toContain("RELAY_API_KEY");
    await s.close();
  });

  it("maps an SDK error to class, code, requestId; the key never appears", async () => {
    const key = "relay_sk_secret_value_123";
    const m = mockFetch([{ method: "GET", path: "/v2/customer/credits", reply: apiError(402, "KEY_BUDGET_EXHAUSTED", `budget spent for ${key}`, "req_abc") }]);
    const s = await connect({ fetch: m.fetch, tools: [ping], credential: { apiKey: key } });
    const r = await s.call("ping_billed", { echo: "x" });
    const t = textOf(r);
    expect(r.isError).toBe(true);
    expect(t).toContain("KeyBudgetExhaustedError");
    expect(t).toContain("code: KEY_BUDGET_EXHAUSTED");
    expect(t).toContain("requestId: req_abc");
    expect(t).not.toContain(key);
    expect(m.calls[0].headers.get("x-api-key")).toBe(key);
    await s.close();
  });

  it("a billed tool is refused before its handler without a credential; billed descriptions say so", async () => {
    let ran = false;
    const billed = defineTool({ name: "billed_x", title: "X", description: "Does x.", inputSchema: {}, billed: true, async handler() {
      ran = true;
      return jsonResult({});
    } });
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: [billed, ping], credential: null, transport: "http" });
    const r = await s.call("billed_x");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(ran).toBe(false);
    const { tools } = await s.client.listTools();
    expect(tools.find((t) => t.name === "billed_x")?.description).toBe("Does x. Needs a Relay credential.");
    expect(tools.find((t) => t.name === "ping_billed")?.description).toBe("test tool");
    expect(tools.find((t) => t.name === "billed_x")?.annotations?.title).toBe("X");
    await s.close();
    expect(ALL_TOOLS.filter((t) => t.billed).map((t) => t.name).sort()).toEqual(
      ["cancel_workflow_run", "get_credits", "get_usage", "run_model", "run_workflow", "upload_file"],
    );
  });

  it("jsonResult pretty-prints under 4 KB, compact above", () => {
    const small = jsonResult({ a: 1 });
    expect((small.content[0] as { text: string }).text).toBe('{\n  "a": 1\n}');
    const big = jsonResult({ a: "x".repeat(5000) });
    expect((big.content[0] as { text: string }).text).toBe(JSON.stringify({ a: "x".repeat(5000) }));
  });
});
