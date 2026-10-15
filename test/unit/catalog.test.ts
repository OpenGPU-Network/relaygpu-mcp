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
    expect(body.models[0]).toEqual({ name: KLING, display_name: "v3-T2V", tag: "text-to-video", endpoint: `/v2/x/${KLING}`, async_default: true, store_output_supported: true, accepts: [] });
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

  const schema = (...props: string[]) => ({ type: "object", properties: Object.fromEntries(["prompt", ...props].map((p) => [p, { type: "string" }])) });
  const EDIT_CATALOG = {
    auto: {
      image: [
        row(QWEN, "text-to-image"),
        row("google/gemini-nano-banana-2.1", "text-to-image"),
        row("openai/gpt-image-2", "text-to-image"),
        row("black-forest-labs/FLUX-2-pro", "text-to-image"),
        row("Qwen/qwen-image-edit", "image-to-image"),
        row("broken/detail", "text-to-image"),
      ],
      video: [row("KlingTeam/v3-I2V", "image-to-video")],
    },
    model_restrictions_per_tier: {},
  };
  const SCHEMAS: Record<string, unknown> = {
    [QWEN]: schema("size"),
    "google/gemini-nano-banana-2.1": schema("image", "images"),
    "openai/gpt-image-2": schema("image"),
    "black-forest-labs/FLUX-2-pro": schema("input_image", "input_image_2"),
    "Qwen/qwen-image-edit": schema("image"),
    "KlingTeam/v3-I2V": schema("image"),
  };
  const editRoutes = () =>
    mockFetch([
      { method: "GET", path: "/v2/models", reply: { json: EDIT_CATALOG } },
      { method: "GET", path: modelPath("broken/detail"), reply: apiError(500, "INTERNAL_ERROR", "boom") },
      {
        method: "GET",
        path: /^\/v2\/models\//,
        reply: (c) => {
          const name = decodeURIComponent(c.path.slice("/v2/models/".length));
          return { json: modelDetail(name, { request_schema: SCHEMAS[name] }) };
        },
      },
    ]);

  it("A3 search_models(image-to-image) adds image-output models whose schema takes image/images/input_image, each accepts: [image]", async () => {
    const m = editRoutes();
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const r = await s.call("search_models", { tag: "image-to-image" });
    expect(r.isError).toBeFalsy();
    const body = json(r);
    expect(body.models.map((x: { name: string }) => x.name)).toEqual([
      "google/gemini-nano-banana-2.1",
      "openai/gpt-image-2",
      "black-forest-labs/FLUX-2-pro",
      "Qwen/qwen-image-edit",
    ]);
    for (const x of body.models) expect(x.accepts).toEqual(["image"]);
    // Tags are reported as registered; a video model taking an image is not an image editor.
    expect(body.models[0].tag).toBe("text-to-image");
    expect(m.calls.some((c) => c.path === modelPath("KlingTeam/v3-I2V"))).toBe(false);
    // A query still narrows the widened set.
    const q = json(await s.call("search_models", { tag: "image-to-image", query: "gemini" }));
    expect(q.models.map((x: { name: string }) => x.name)).toEqual(["google/gemini-nano-banana-2.1"]);
    await s.close();
  });

  it("0.1.7 A8 search_models(text-to-image): every row carries accepts, [\"image\"] only for schema-matched editors", async () => {
    const m = editRoutes();
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const r = await s.call("search_models", { tag: "text-to-image" });
    const accepts = Object.fromEntries(json(r).models.map((x: { name: string; accepts: string[] }) => [x.name, x.accepts]));
    expect(accepts).toEqual({
      [QWEN]: [],
      "google/gemini-nano-banana-2.1": ["image"],
      "openai/gpt-image-2": ["image"],
      "black-forest-labs/FLUX-2-pro": ["image"],
      "broken/detail": [], // a detail that fails to load is no editor, never fatal
    });
    expect(textOf(r)).toMatchSnapshot();
    await s.close();
  });

  it("F5 estimate_cost duration_seconds names the input video's length for edits", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const { tools } = await s.client.listTools();
    const usage = tools.find((t) => t.name === "estimate_cost")!.inputSchema.properties!.usage as { properties: Record<string, { description: string }> };
    expect(usage.properties.duration_seconds.description).toContain(
      "seconds of output; for an edit of an input video (Kling Omni/o1 base_video_url, Motion Control) pass the input video's length, which is what is rendered and billed",
    );
    await s.close();
  });
});
