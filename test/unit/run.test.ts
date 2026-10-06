import { describe, expect, it } from "vitest";
import { runTools } from "../../src/tools/run.js";
import { EXPIRY_NOTE } from "../../src/media.js";
import { apiError, connect, mockFetch, textOf, type RecordedCall, type Route } from "../helpers/harness.js";
import { GPT_IMAGE, KLING, QWEN, b64, fileResponse, imagesOf, jsonOf, modelDetail, modelPath, notesOf, pngBytes } from "../fixtures/relay.js";

const TASK = "direct:7b1e2c4a-0000-4000-8000-000000000001";
const SENTENCE = "Do not resubmit: call check_task with this task_id";
const QWEN_ROUTE = "/v2/image/qwen/generate";
const KLING_ROUTE = "/v2/video/kling-3/t2v";
const GPT_ROUTE = "/v2/image/gpt-image-2/generate";
const IMG_URL = "https://cdn.provider.test/out/abc.png";

const qwenDetail: Route = { method: "GET", path: modelPath(QWEN), reply: { json: modelDetail(QWEN) } };
const klingDetail: Route = {
  method: "GET",
  path: modelPath(KLING),
  reply: { json: modelDetail(KLING, { tag: "text-to-video", endpoint: { path: KLING_ROUTE, async_default: true, operation_id: "video_kling_3_t2v" } }) },
};
const gptDetail: Route = {
  method: "GET",
  path: modelPath(GPT_IMAGE),
  reply: { json: modelDetail(GPT_IMAGE, { store_output_supported: false, endpoint: { path: GPT_ROUTE } }) },
};
const accepted: Route = {
  method: "POST",
  path: KLING_ROUTE,
  reply: { status: 202, json: { task_id: TASK, status: "queued", poll_url: `/v2/tasks/${TASK}`, message: "queued" } },
};
const taskRoute = (json: Record<string, unknown>): Route => ({ method: "GET", path: /^\/v2\/tasks\//, reply: { json: { elapsed_seconds: 3, ...json } } });

const posts = (calls: RecordedCall[], path?: string) => calls.filter((c) => c.method === "POST" && (!path || c.path === path));

describe("run_model (F4, F5)", () => {
  it("A3 unknown model fails before submit (zero POSTs)", async () => {
    const m = mockFetch([{ method: "GET", path: /^\/v2\/models\//, reply: apiError(404, "MODEL_NOT_FOUND", "Model 'nope/none' not found") }]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: "nope/none", input: { prompt: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("code: MODEL_NOT_FOUND");
    expect(posts(m.calls)).toHaveLength(0);
    await s.close();
  });

  it("A3 retired model fails before submit (zero POSTs)", async () => {
    const m = mockFetch([
      { method: "GET", path: modelPath(QWEN), reply: { json: modelDetail(QWEN, { status: "retired", available: false, endpoint: { path: QWEN_ROUTE } }) } },
      { method: "POST", path: QWEN_ROUTE, reply: { json: { data: [] } } },
    ]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: QWEN, input: { prompt: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("ModelRetiredError");
    expect(textOf(r)).toContain("code: MODEL_RETIRED");
    expect(posts(m.calls)).toHaveLength(0);
    await s.close();
  });

  it("A3 sync URL route returns the link with its expiry note", async () => {
    const m = mockFetch([qwenDetail, { method: "POST", path: QWEN_ROUTE, reply: { json: { created: 1, data: [{ url: IMG_URL }] } } }]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: QWEN, input: { prompt: "a cat" } });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r).data[0].url).toBe(IMG_URL);
    expect(notesOf(r)).toContain(`${IMG_URL}: ${EXPIRY_NOTE}`);
    const post = posts(m.calls, QWEN_ROUTE)[0];
    expect(post.body).toMatchObject({ prompt: "a cat", model: QWEN });
    expect((post.body as Record<string, unknown>).store_output).toBeUndefined();
    await s.close();
  });

  it("A3 async past the wait window returns task_id + the do-not-resubmit sentence, exactly one POST", async () => {
    const m = mockFetch([klingDetail, accepted, taskRoute({ task_id: TASK, status: "running" })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: KLING, input: { prompt: "a wave", duration: 3 }, wait_seconds: 1 });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toContain(SENTENCE);
    const body = jsonOf(r);
    expect(body).toMatchObject({ task_id: TASK, poll_url: `/v2/tasks/${TASK}`, status: "running", replayed: false });
    expect(posts(m.calls)).toHaveLength(1);
    expect(posts(m.calls)[0].headers.get("idempotency-key")).toBeTruthy(); // the SDK's auto key
    await s.close();
  });

  it("A3 wait_seconds 0 answers the task_id without polling", async () => {
    const m = mockFetch([klingDetail, accepted]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: KLING, input: { prompt: "a wave" }, wait_seconds: 0 });
    expect(textOf(r)).toContain(SENTENCE);
    expect(jsonOf(r).status).toBe("queued");
    expect(m.calls.filter((c) => c.path.startsWith("/v2/tasks/"))).toHaveLength(0);
    expect(posts(m.calls)).toHaveLength(1);
    await s.close();
  });

  it("A3 async task completing inside the window returns its result", async () => {
    const video = "https://cdn.provider.test/out/v.mp4";
    const m = mockFetch([klingDetail, accepted, taskRoute({ task_id: TASK, status: "completed", result: { video_url: video } })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: KLING, input: { prompt: "a wave" }, wait_seconds: 5 });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toEqual({ video_url: video });
    expect(notesOf(r)).toContain(TASK);
    expect(notesOf(r)).toContain(video);
    expect(posts(m.calls)).toHaveLength(1);
    await s.close();
  });

  it("A3 a failed task is a tool error carrying the task's error_code", async () => {
    const m = mockFetch([
      klingDetail,
      accepted,
      taskRoute({ task_id: TASK, status: "failed", error: "The provider declined the prompt", error_code: "CONTENT_POLICY_DECLINED" }),
    ]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: KLING, input: { prompt: "x" }, wait_seconds: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("TaskFailedError");
    expect(textOf(r)).toContain("code: CONTENT_POLICY_DECLINED");
    expect(textOf(r)).toContain(`task_id: ${TASK}`);
    await s.close();
  });

  it("F4 idempotency_key is forwarded as the Idempotency-Key header", async () => {
    const m = mockFetch([klingDetail, accepted]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    await s.call("run_model", { model: KLING, input: { prompt: "x" }, wait_seconds: 0, idempotency_key: "my-key-1" });
    expect(posts(m.calls)[0].headers.get("idempotency-key")).toBe("my-key-1");
    await s.close();
  });

  it("F4 without a credential: MISSING_CREDENTIALS and zero POSTs", async () => {
    const m = mockFetch([qwenDetail]);
    const s = await connect({ fetch: m.fetch, tools: runTools, credential: null });
    const r = await s.call("run_model", { model: QWEN, input: { prompt: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(posts(m.calls)).toHaveLength(0);
    await s.close();
  });

  const png = pngBytes(600);
  const pngB64 = b64(png);
  const gptSync: Route = { method: "POST", path: GPT_ROUTE, reply: { json: { created: 1, data: [{ b64_json: pngB64 }] } } };
  const filesOk: Route = { method: "POST", path: "/v2/files", reply: (c) => ({ status: 201, json: fileResponse({ retention: c.query.get("retention") ?? "relay1h" }) }) };

  it("A4 base64-only result re-hosted", async () => {
    const m = mockFetch([gptDetail, gptSync, filesOk]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" } });
    expect(r.isError).toBeFalsy();
    expect(posts(m.calls, "/v2/files")).toHaveLength(1);
    const upload = posts(m.calls, "/v2/files")[0];
    expect(Buffer.from(upload.body as Uint8Array).equals(Buffer.from(png))).toBe(true);
    expect(upload.headers.get("content-type")).toBe("image/png");
    expect(upload.query.get("retention")).toBe("relay1h");
    const body = jsonOf(r);
    expect(body.data[0].b64_json).toBe(fileResponse().url);
    expect(body.rehosted).toEqual([{ url: fileResponse().url, file_id: "file_abc123", expires_at: fileResponse().expires_at, retention: "relay1h" }]);
    const all = JSON.stringify(r);
    expect(all).not.toContain(pngB64.slice(0, 40));
    expect(imagesOf(r)).toHaveLength(0);
    expect(notesOf(r)).toContain("re-hosted through /v2/files (relay1h)");
    await s.close();
  });

  it("A4 inline_images ≤1MB adds image block", async () => {
    const m = mockFetch([gptDetail, gptSync, filesOk]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, inline_images: true });
    const imgs = imagesOf(r);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].mimeType).toBe("image/png");
    expect(imgs[0].data).toBe(pngB64);
    // The JSON text still carries no base64.
    expect(textOf(r)).not.toContain(pngB64.slice(0, 40));
    await s.close();
  });

  it("A4 >1MB never inlined", async () => {
    const big = pngBytes(1_100_000);
    const m = mockFetch([gptDetail, { method: "POST", path: GPT_ROUTE, reply: { json: { data: [{ b64_json: b64(big) }] } } }, filesOk]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, inline_images: true });
    expect(imagesOf(r)).toHaveLength(0);
    expect(notesOf(r)).toContain("image > 1 MB not inlined");
    expect(posts(m.calls, "/v2/files")).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain(b64(big).slice(0, 40));
    await s.close();
  });

  it("A4 store_output relay7d forwarded on URL route (body.store_output)", async () => {
    const m = mockFetch([qwenDetail, { method: "POST", path: QWEN_ROUTE, reply: { json: { data: [{ url: IMG_URL }] } } }]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: QWEN, input: { prompt: "a cat" }, store_output: "relay7d" });
    expect((posts(m.calls, QWEN_ROUTE)[0].body as Record<string, unknown>).store_output).toBe("relay7d");
    expect(notesOf(r)).toContain(`${IMG_URL}: stored as relay7d: kept for 7 days`);
    await s.close();
  });

  it("A4 store_output relay7d mapped to retention relay7d on base64-only route (query retention=relay7d, body has no store_output)", async () => {
    const m = mockFetch([gptDetail, gptSync, filesOk]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: GPT_IMAGE, input: { prompt: "a cat" }, store_output: "relay7d" });
    expect(r.isError).toBeFalsy();
    expect((posts(m.calls, GPT_ROUTE)[0].body as Record<string, unknown>).store_output).toBeUndefined();
    const upload = posts(m.calls, "/v2/files")[0];
    expect(upload.query.get("retention")).toBe("relay7d");
    expect(jsonOf(r).rehosted[0].retention).toBe("relay7d");
    await s.close();
  });

  it("A4 store_output on a URL route without store_output support is not forwarded and says so", async () => {
    const m = mockFetch([
      { method: "GET", path: modelPath(QWEN), reply: { json: modelDetail(QWEN, { store_output_supported: false }) } },
      { method: "POST", path: QWEN_ROUTE, reply: { json: { data: [{ url: IMG_URL }] } } },
    ]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("run_model", { model: QWEN, input: { prompt: "a cat" }, store_output: "relay7d" });
    expect((posts(m.calls, QWEN_ROUTE)[0].body as Record<string, unknown>).store_output).toBeUndefined();
    expect(notesOf(r)).toContain("store_output is not supported by this model; the link expires 1 h after completion");
    await s.close();
  });
});

describe("check_task (F3)", () => {
  it("A3 check_task completed returns the result", async () => {
    const m = mockFetch([taskRoute({ task_id: TASK, status: "completed", result: { video_url: "https://cdn.provider.test/v.mp4" } })]);
    const s = await connect({ fetch: m.fetch, tools: runTools, credential: null });
    const r = await s.call("check_task", { task_id: TASK, wait_seconds: 5 });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r).video_url).toBe("https://cdn.provider.test/v.mp4");
    expect(notesOf(r)).toContain(EXPIRY_NOTE);
    expect(m.calls[0].query.get("wait")).toBe("5");
    expect(m.calls[0].headers.get("x-api-key")).toBeNull();
    await s.close();
  });

  it("A3 check_task running past the window answers the status and says call again", async () => {
    const m = mockFetch([taskRoute({ task_id: TASK, status: "running" })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("check_task", { task_id: TASK, wait_seconds: 1 });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ task_id: TASK, status: "running" });
    expect(textOf(r)).toContain("Still running: call check_task again with this task_id; do not resubmit.");
    await s.close();
  });

  it("A3 check_task wait_seconds 0 reads once without wait", async () => {
    const m = mockFetch([taskRoute({ task_id: TASK, status: "queued" })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    const r = await s.call("check_task", { task_id: TASK, wait_seconds: 0 });
    expect(jsonOf(r).status).toBe("queued");
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].query.get("wait")).toBeNull();
    await s.close();
  });

  it("A3 check_task failed is a tool error with the task's error_code (waiting and not)", async () => {
    const m = mockFetch([taskRoute({ task_id: TASK, status: "failed", error: "Provider unavailable", error_code: "PROVIDER_UNAVAILABLE" })]);
    const s = await connect({ fetch: m.fetch, tools: runTools });
    for (const wait_seconds of [0, 5]) {
      const r = await s.call("check_task", { task_id: TASK, wait_seconds });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("code: PROVIDER_UNAVAILABLE");
    }
    await s.close();
  });
});
