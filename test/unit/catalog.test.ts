import { describe, expect, it } from "vitest";
import { catalogTools } from "../../src/tools/catalog.js";
import { apiError, connect, mockFetch, textOf } from "../helpers/harness.js";
import { KLING, PRICING, QWEN, jsonOf, modelDetail, modelPath } from "../fixtures/relay.js";

const row = (name: string, tag: string, extra: Record<string, unknown> = {}) => ({
  name,
  display_name: name.split("/")[1],
  tag,
  store_output_supported: true,
  endpoint: { method: "POST", path: `/v2/x/${name}`, operation_id: "op", model_in_body: true, async_default: tag.includes("video"), streams: false },
  ...extra,
});

const CATALOG = {
  auto: {
    image: [row(QWEN, "text-to-image"), row("Qwen/qwen-image-edit", "image-to-image")],
    video: [row(KLING, "text-to-video"), row("KlingTeam/v3-I2V", "image-to-video")],
  },
  direct: { image: [row(QWEN, "text-to-image")] },
  model_restrictions_per_tier: {},
};

const json = jsonOf;

describe("catalog tools (F3)", () => {
  it("F3 search_models filters by tag and every query word, keyless", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/models", reply: { json: CATALOG } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    let r = await s.call("search_models", { tag: "text-to-video" });
    expect(r.isError).toBeFalsy();
    let body = json(r);
    expect(body.total).toBe(1);
    expect(body.models[0]).toEqual({ name: KLING, display_name: "v3-T2V", tag: "text-to-video", endpoint: `/v2/x/${KLING}`, async_default: true, store_output_supported: true });
    r = await s.call("search_models", { query: "QWEN edit" });
    body = json(r);
    expect(body.models.map((x: { name: string }) => x.name)).toEqual(["Qwen/qwen-image-edit"]);
    expect(textOf(r)).toContain("get_model");
    expect(m.calls.every((c) => c.headers.get("x-api-key") === null)).toBe(true);
    await s.close();
  });

  it("F3 search_models caps at 50 with the total and a narrowing note", async () => {
    const many = Array.from({ length: 70 }, (_, i) => row(`Org/m-${i}`, "text-to-text"));
    const m = mockFetch([{ method: "GET", path: "/v2/models", reply: { json: { auto: { chat: many }, model_restrictions_per_tier: {} } } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools });
    const r = await s.call("search_models", {});
    const body = json(r);
    expect(body.total).toBe(70);
    expect(body.models).toHaveLength(50);
    expect(textOf(r)).toContain("narrow with tag/query");
    await s.close();
  });

  it("F3 get_model returns schema, example, pricing and status; unknown → MODEL_NOT_FOUND", async () => {
    const m = mockFetch([
      { method: "GET", path: modelPath(QWEN), reply: { json: modelDetail(QWEN) } },
      { method: "GET", path: /^\/v2\/models\//, reply: apiError(404, "MODEL_NOT_FOUND", "Model 'nope/x' not found") },
    ]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const r = await s.call("get_model", { model: QWEN });
    const body = json(r);
    expect(body.request_schema).toBeTruthy();
    expect(body.request_example).toEqual({ prompt: "a cat" });
    expect(body.pricing[0].per_image).toBe(0.036);
    expect(body.status).toBe("available");
    expect(body.endpoint.path).toBe("/v2/image/qwen/generate");
    expect(body.response_schema_url).toBe("#/components/schemas/Y");
    expect(body.restricted_tiers).toEqual(["guest"]);
    expect(textOf(r)).toContain("run_model");
    const bad = await s.call("get_model", { model: "nope/x" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("ModelNotFoundError");
    expect(textOf(bad)).toContain("code: MODEL_NOT_FOUND");
    await s.close();
  });

  it("F3/F5 get_pricing filters by model (after the source prefix) and always carries media_storage", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/pricing", reply: { json: PRICING } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    let body = json(await s.call("get_pricing", { model: KLING }));
    expect(body.pricing).toHaveLength(1);
    expect(body.pricing[0].model).toBe(`video.${KLING}`);
    expect(body.media_storage).toEqual(PRICING.media_storage);
    body = json(await s.call("get_pricing", {}));
    expect(body.pricing).toHaveLength(3);
    expect(body.media_storage.relay7d).toBe(0.001);
    await s.close();
  });

  it("F3 estimate_cost computes from /v2/pricing and says it is an estimate", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/pricing", reply: { json: PRICING } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const r = await s.call("estimate_cost", { model: KLING, usage: { duration_seconds: 5, quality_mode: "std", sound: false, store_output: "relay7d" } });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body.usd).toBeCloseTo(5 * 0.084 + 0.001, 8);
    expect(body.basis).toContain("per_second_video");
    expect(textOf(r)).toContain("not an invoice");
    await s.close();
  });
});
