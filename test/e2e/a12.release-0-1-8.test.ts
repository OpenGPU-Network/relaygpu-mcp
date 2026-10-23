// 0.1.8 against staging: catalog lookups run as the caller's account. The SDK test account is granted the private
// groups `anthropic` and `filter-off`; keyless callers must not see those models. Reads only: no run_model.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, HAS_BASE, HAS_KEY, mcpHttp, startHosted, textOf } from "./harness.js";
import { jsonOf } from "../fixtures/relay.js";

const HAIKU = "anthropic/claude-haiku-5-5";
const FILTER_OFF = "ByteDance/doubao-seedance-2-0-filter-off";

let hosted: Awaited<ReturnType<typeof startHosted>> | undefined;
beforeAll(async () => {
  if (HAS_BASE) hosted = await startHosted();
});
afterAll(async () => {
  await hosted?.close();
});

const names = (r: Parameters<typeof jsonOf>[0]) => (jsonOf(r).models as { name: string }[]).map((m) => m.name);

describe.skipIf(!HAS_KEY)("0.1.8 keyed lookups (staging)", () => {
  it("keyed get_model answers the granted model's detail", async () => {
    const mcp = await mcpHttp(hosted!.url, { "X-API-Key": API_KEY });
    try {
      const r = await mcp.call("get_model", { model: HAIKU });
      expect(r.isError, textOf(r)).toBeFalsy();
      const d = jsonOf(r);
      expect(d.endpoint.path).toBe("/v2/anthropic/v1/messages");
      expect(d.status).toBe("available");
    } finally {
      await mcp.close();
    }
  });

  it("keyed search_models finds the granted models", async () => {
    const mcp = await mcpHttp(hosted!.url, { "X-API-Key": API_KEY });
    try {
      const claude = await mcp.call("search_models", { query: "claude" });
      expect(names(claude).length).toBeGreaterThan(0);
      expect(names(claude)).toContain(HAIKU);
      expect(names(await mcp.call("search_models", { query: "filter-off" }))).toContain(FILTER_OFF);
    } finally {
      await mcp.close();
    }
  });

  it("keyed estimate_cost for the granted model is positive", async () => {
    const mcp = await mcpHttp(hosted!.url, { "X-API-Key": API_KEY });
    try {
      const r = await mcp.call("estimate_cost", { model: HAIKU, usage: { input_tokens: 1000, output_tokens: 100 } });
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(jsonOf(r).usd).toBeGreaterThan(0);
    } finally {
      await mcp.close();
    }
  });
});

describe.skipIf(!HAS_BASE)("0.1.8 keyless lookups (staging)", () => {
  it("keyless get_model of the private model is MODEL_NOT_FOUND", async () => {
    const mcp = await mcpHttp(hosted!.url);
    try {
      const r = await mcp.call("get_model", { model: HAIKU });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("MODEL_NOT_FOUND");
    } finally {
      await mcp.close();
    }
  });

  it("keyless search_models returns no private model", async () => {
    const mcp = await mcpHttp(hosted!.url);
    try {
      expect(names(await mcp.call("search_models", { query: "claude" }))).toEqual([]);
      expect(names(await mcp.call("search_models", { query: "filter-off" }))).not.toContain(FILTER_OFF);
    } finally {
      await mcp.close();
    }
  });
});
