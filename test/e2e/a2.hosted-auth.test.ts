// A2 (F1, F2): hosted (local, PORT or 2300): keyless tools without a header; a billed tool names X-API-Key;
// with the header it runs. Billed: one Qwen image.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, HAS_BASE, HAS_KEY, QWEN, TOOL_NAMES, URL_RE, mcpHttp, startHosted, textOf, type McpHandle } from "./harness.js";

describe.skipIf(!HAS_BASE)("A2 hosted auth", () => {
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let anon: McpHandle;

  beforeAll(async () => {
    hosted = await startHosted();
    anon = await mcpHttp(hosted.url);
  });
  afterAll(async () => {
    await anon?.close();
    await hosted?.close();
  });

  it("A2 tools/list answers without a header (14 tools)", async () => {
    const { tools } = await anon.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
  });

  it("A2 search_models without a header returns rows", async () => {
    const r = await anon.call("search_models", {});
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/[\w.-]+\/[\w.-]+/); // at least one org/model name
  });

  it("A2 run_model without a header → MISSING_CREDENTIALS naming X-API-Key", async () => {
    const r = await anon.call("run_model", QWEN);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(textOf(r)).toContain("X-API-Key");
  });

  it.skipIf(!HAS_KEY)("A2 run_model with X-API-Key runs (1 billed image)", async () => {
    const keyed = await mcpHttp(hosted.url, { "X-API-Key": API_KEY });
    try {
      const r = await keyed.call("run_model", QWEN);
      expect(r.isError, textOf(r)).toBeFalsy();
      expect(textOf(r)).toMatch(URL_RE);
    } finally {
      await keyed.close();
    }
  });
});
