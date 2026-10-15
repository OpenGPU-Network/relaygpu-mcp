// 0.1.7 (PRD mcp_0_1_7 F1–F7): async-always run_model, honest text, the slot's open_url, the hosted upload schema,
// the tier check, accepts on every row, one place per field.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RelayAPIError } from "@relaygpu/client";
import { errorText } from "../../src/errors.js";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { MODE_SENTENCE, catalogTools } from "../../src/tools/catalog.js";
import { HOSTED_PATH_REFUSAL, filesTools } from "../../src/tools/files.js";
import { ASYNC_NOTE, DO_NOT_RESUBMIT, DROPPED_NOTE, runTools } from "../../src/tools/run.js";
import { apiError, connect, mockFetch, posts, textOf, type Route } from "../helpers/harness.js";
import { GPT_IMAGE, PRICING, jsonOf, modelDetail, modelPath, notesOf } from "../fixtures/relay.js";

const TASK = "direct:0a17c0de-0000-4000-8000-000000000017";
const GPT_ROUTE = "/v2/image/gpt-image-2/generate";
const CHAT = "openai/gpt-5.4";
const CHAT_ROUTE = "/v2/openai/v1/chat/completions";
const IMG_URL = "https://cdn.relaygpu.test/content/out.png";

const asyncSchema = { type: "object", properties: { prompt: { type: "string" }, image: { type: "string" }, async: { type: "boolean" } } };
const gptDetail: Route = {
  method: "GET",
  path: modelPath(GPT_IMAGE),
  reply: { json: modelDetail(GPT_IMAGE, { request_schema: asyncSchema, endpoint: { path: GPT_ROUTE, async_default: false } }) },
};
const chatDetail: Route = {
  method: "GET",
  path: modelPath(CHAT),
  reply: {
    json: modelDetail(CHAT, {
      tag: "text-to-text",
      request_schema: { type: "object", properties: { messages: { type: "array" }, max_tokens: { type: "integer" } } },
      endpoint: { path: CHAT_ROUTE, async_default: false },
    }),
  },
};
const accepted = (replayed = false): Route => ({
  method: "POST",
  path: GPT_ROUTE,
  reply: {
    status: 202,
    json: { task_id: TASK, status: "queued", poll_url: `/v2/tasks/${TASK}`, message: "queued" },
    headers: replayed ? { "idempotency-replayed": "true" } : {},
  },
});
const task = (json: Record<string, unknown>): Route => ({ method: "GET", path: /^\/v2\/tasks\//, reply: { json: { task_id: TASK, elapsed_seconds: 4, ...json } } });
const bodyOf = (m: ReturnType<typeof mockFetch>, path: string) => posts(m.calls, path)[0].body as Record<string, unknown>;

describe("F1 async-always run_model", () => {
  it("A1 a route whose schema takes async is submitted async: true; past wait_seconds → task_id + check_task", async () => {
    const m = mockFetch([gptDetail, accepted(), task({ status: "running" })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat", image: IMG_URL, quality: "high" }, wait_seconds: 1 });
    expect(r.isError).toBeFalsy();
    expect(bodyOf(m, GPT_ROUTE)).toEqual({ prompt: "a cat", image: IMG_URL, quality: "high", async: true, model: GPT_IMAGE });
    expect(posts(m.calls)[0].headers.get("idempotency-key")).toBeTruthy();
    const body = jsonOf(r);
    expect(body).toMatchObject({ status: "running", task_id: TASK, next: { tool: "check_task", args: { task_id: TASK } } });
    expect(textOf(r)).toContain(DO_NOT_RESUBMIT);
    expect(posts(m.calls)).toHaveLength(1);
    await s.close();
  });

  it("A1 a task completing inside the window answers its result (no task left to poll)", async () => {
    const m = mockFetch([gptDetail, accepted(), task({ status: "completed", result: { created: 1, data: [{ url: IMG_URL }] } })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, wait_seconds: 5 });
    const body = jsonOf(r);
    expect(body.status).toBe("completed");
    expect(body.task_id).toBe(TASK);
    expect(body.output.data[0].url).toBe(IMG_URL);
    expect(body.replayed).toBeUndefined();
    await s.close();
  });

  it("a caller's async: false is replaced by async: true, with a note; async: true needs none", async () => {
    const m = mockFetch([gptDetail, accepted()]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    let r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat", async: false }, wait_seconds: 0 });
    expect(bodyOf(m, GPT_ROUTE).async).toBe(true);
    expect(notesOf(r)).toContain(ASYNC_NOTE);
    r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat", async: true }, wait_seconds: 0 });
    expect(notesOf(r)).not.toContain(ASYNC_NOTE);
    await s.close();
  });

  it("A3 a chat model (no async in its schema) is sent unchanged, without async, and answers inline", async () => {
    const reply = { id: "chatcmpl-1", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] };
    const m = mockFetch([chatDetail, { method: "POST", path: CHAT_ROUTE, reply: { json: reply } }]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: CHAT, input: { messages: [{ role: "user", content: "hi" }], max_tokens: 5 } });
    expect(r.isError).toBeFalsy();
    expect(bodyOf(m, CHAT_ROUTE)).toMatchInlineSnapshot(`
      {
        "max_tokens": 5,
        "messages": [
          {
            "content": "hi",
            "role": "user",
          },
        ],
        "model": "openai/gpt-5.4",
      }
    `);
    expect(jsonOf(r)).toMatchObject({ status: "completed", output: { choices: [{ message: { content: "hi" } }] } });
    expect(jsonOf(r).task_id).toBeUndefined();
    expect(m.calls.some((c) => c.path.startsWith("/v2/tasks/"))).toBe(false);
    await s.close();
  });

  it("A2 the same key replays: replayed: true and the same task_id; a changed body → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const m = mockFetch([gptDetail, accepted(true)]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, wait_seconds: 0, idempotency_key: "k-1" });
    expect(jsonOf(r)).toMatchObject({ task_id: TASK, replayed: true });
    expect(posts(m.calls)[0].headers.get("idempotency-key")).toBe("k-1");
    const reused = mockFetch([gptDetail, { method: "POST", path: GPT_ROUTE, reply: apiError(422, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key reused with a different body") }]);
    const s2 = await connect({ fetch: reused.fetch, tools: runTools });
    const bad = await s2.call("run_model", { model: GPT_IMAGE, input: { prompt: "a dog" }, idempotency_key: "k-1" });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("code: IDEMPOTENCY_KEY_REUSED");
    await s.close();
    await s2.close();
  });
});

describe("F2 honest text", () => {
  it("run_model's and idempotency_key's descriptions hold for every route", async () => {
    const s = await connect({ fetch: mockFetch([]).fetch, tools: runTools });
    const run = (await s.client.listTools()).tools.find((t) => t.name === "run_model")!;
    expect(run.description).toContain("Every model whose schema takes async (image, video, audio) is submitted as a task");
    expect(run.description).toContain("Chat models answer inline.");
    const idem = (run.inputSchema.properties!.idempotency_key as { description: string }).description;
    expect(idem).toContain("422 IDEMPOTENCY_KEY_REUSED");
    expect(idem).toContain("a chat answer is not replayed");
    await s.close();
  });

  it("A4 retry_after_seconds only on 429 and 503, never on 524 or 504", () => {
    const err = (status: number) => new RelayAPIError({ message: `HTTP ${status}`, status, retryAfter: 120 });
    expect(errorText(err(524), "http")).not.toContain("retry_after_seconds");
    expect(errorText(err(504), "http")).not.toContain("retry_after_seconds");
    expect(errorText(err(429), "http")).toContain("retry_after_seconds: 120");
    expect(errorText(err(503), "http")).toContain("retry_after_seconds: 120");
  });
});

describe("F4 hosted upload_file schema", () => {
  const props = async (transport: "http" | "stdio") => {
    const s = await connect({ fetch: mockFetch([]).fetch, tools: filesTools, transport });
    const t = (await s.client.listTools()).tools.find((x) => x.name === "upload_file")!;
    await s.close();
    return Object.keys(t.inputSchema.properties ?? {});
  };

  it("A6 the hosted schema lists no path; the stdio schema does", async () => {
    expect(await props("http")).toEqual(["base64", "url", "slot", "retention", "filename"]);
    expect(await props("stdio")).toContain("path");
  });

  it("A6 a hosted caller sending path anyway still gets the refusal (zero requests)", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, transport: "http" });
    const r = await s.call("upload_file", { path: "/tmp/x.png" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(HOSTED_PATH_REFUSAL);
    expect(m.calls).toHaveLength(0);
    await s.close();
  });
});

describe("F5 estimate_cost tier check", () => {
  const NB = "google/gemini-nano-banana-2.1";
  const pricing = {
    ...PRICING,
    pricing: [...PRICING.pricing, { mode: "direct", model: `image.${NB}`, billing_type: "per_image", per_image_resolution: { "1K": 0.0336, "2K": 0.0504, "4K": 0.0756 } }],
  };

  it("A7 an unpriced resolution_tier is refused naming the row's keys; a priced one estimates as before", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/pricing", reply: { json: pricing } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    const bad = await s.call("estimate_cost", { model: NB, usage: { image_count: 1, resolution_tier: "8K" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('resolution_tier "8K" is not priced');
    expect(textOf(bad)).toContain("1K, 2K, 4K");
    const ok = await s.call("estimate_cost", { model: NB, usage: { image_count: 1, resolution_tier: "2K" } });
    expect(ok.isError).toBeFalsy();
    expect(jsonOf(ok).usd).toBeCloseTo(0.0504, 8);
    await s.close();
  });

  it("a video tier matches a key's first segment; a row without a tier map ignores resolution_tier", async () => {
    const video = { mode: "direct", model: "video.Wan-AI/Wan2.5-T2V", billing_type: "per_second_video", per_second_video: { "480p": 0.05, "720p": 0.1 } };
    const m = mockFetch([{ method: "GET", path: "/v2/pricing", reply: { json: { ...pricing, pricing: [...pricing.pricing, video] } } }]);
    const s = await connect({ fetch: m.fetch, tools: catalogTools, credential: null });
    expect((await s.call("estimate_cost", { model: "Wan-AI/Wan2.5-T2V", usage: { duration_seconds: 5, resolution_tier: "720p" } })).isError).toBeFalsy();
    const bad = await s.call("estimate_cost", { model: "Wan-AI/Wan2.5-T2V", usage: { duration_seconds: 5, resolution_tier: "1080p" } });
    expect(textOf(bad)).toContain("480p, 720p");
    const flat = await s.call("estimate_cost", { model: "Qwen/qwen-image", usage: { resolution_tier: "8K" } });
    expect(flat.isError).toBeFalsy();
    await s.close();
  });
});

describe("F6 examples name live models", () => {
  it("A8 no source file under src/tools names a Qwen model", () => {
    const dir = join(__dirname, "../../src/tools");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/qwen/i);
  });

  it("no listed tool text names a Qwen model", async () => {
    const s = await connect({ fetch: mockFetch([]).fetch, tools: ALL_TOOLS });
    expect(JSON.stringify((await s.client.listTools()).tools)).not.toMatch(/qwen/i);
    await s.close();
  });
});

describe("F7 one place per field", () => {
  it("A9 input.store_output is dropped with a note and never sent", async () => {
    const m = mockFetch([gptDetail, accepted()]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat", store_output: "relay7d" }, wait_seconds: 0 });
    expect(r.isError).toBeFalsy();
    expect(bodyOf(m, GPT_ROUTE).store_output).toBeUndefined();
    expect(notesOf(r)).toContain(DROPPED_NOTE("store_output"));
    await s.close();
  });

  it("input.model is dropped with a note; the model argument is what is sent", async () => {
    const m = mockFetch([gptDetail, accepted()]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat", model: "other/model" }, wait_seconds: 0 });
    expect(bodyOf(m, GPT_ROUTE).model).toBe(GPT_IMAGE);
    expect(notesOf(r)).toContain(DROPPED_NOTE("model"));
    await s.close();
  });

  it("the store_output tool argument still applies on a supporting model", async () => {
    const m = mockFetch([gptDetail, accepted()]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, store_output: "relay7d", wait_seconds: 0 });
    expect(bodyOf(m, GPT_ROUTE).store_output).toBe("relay7d");
    await s.close();
  });

  it("mode is the same sentence on run_model and estimate_cost", async () => {
    const s = await connect({ fetch: mockFetch([]).fetch, tools: ALL_TOOLS });
    const { tools } = await s.client.listTools();
    const input = (tools.find((t) => t.name === "run_model")!.inputSchema.properties!.input as { description: string }).description;
    const usage = tools.find((t) => t.name === "estimate_cost")!.inputSchema.properties!.usage as { properties: Record<string, { description: string }> };
    expect(input).toContain(MODE_SENTENCE);
    expect(usage.properties.mode.description).toBe(MODE_SENTENCE);
    await s.close();
  });
});
