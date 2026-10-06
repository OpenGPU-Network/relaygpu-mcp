import { describe, expect, it } from "vitest";
import { workflowTools, DO_NOT_RESUBMIT, STILL_RUNNING } from "../../src/tools/workflows.js";
import { apiError, connect, mockFetch, posts, textOf, type Reply } from "../helpers/harness.js";
import { jsonOf, notesOf } from "../fixtures/relay.js";

const RUN_ID = "wf:0b9c1e2a-1111-4222-8333-944455556666";
const RUN_PATH = `/v2/workflows/runs/${RUN_ID}`;

const run = (status: string, extra: Record<string, unknown> = {}): Reply => ({
  json: {
    run_id: RUN_ID,
    workflow_id: "script-voiceover",
    version: 1,
    status,
    inputs: { topic: "tides" },
    steps: [
      { step_id: "script", step_index: 0, model: "openai/gpt-5.4", status: status === "queued" ? "pending" : "completed", task_id: "direct:aaa", cost_usd: 0.001 },
      { step_id: "voice", step_index: 1, model: "openai/gpt-4o-mini-tts", status: status === "completed" ? "completed" : "submitted", task_id: "direct:bbb" },
    ],
    ...extra,
  },
});

const accepted: Reply = { status: 202, json: { run_id: RUN_ID, status: "queued", poll_url: RUN_PATH } };

describe("workflow tools (A6 call shapes)", () => {
  it("exports the four tools in order", () => {
    expect(workflowTools.map((t) => t.name)).toEqual(["list_workflows", "run_workflow", "check_workflow_run", "cancel_workflow_run"]);
  });

  it("list_workflows: keyless GET /v2/workflows, compact entries, next-step note", async () => {
    const m = mockFetch([
      {
        method: "GET",
        path: "/v2/workflows",
        reply: {
          json: {
            total: 1,
            workflows: [
              {
                workflow_id: "script-voiceover",
                name: "Script to voiceover",
                description: "Writes a script, then voices it",
                version: 3,
                input_schema: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] },
                restricted_tiers: ["guest"],
                steps: [{ step_id: "script", model: "openai/gpt-5.4", source: "openai", endpoint: "/v2/openai/v1/chat/completions" }],
              },
            ],
          },
        },
      },
    ]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools, credential: null });
    const r = await s.call("list_workflows");
    expect(r.isError).toBeFalsy();
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v2/workflows"]);
    expect(m.calls[0].headers.get("x-api-key")).toBeNull();
    const t = textOf(r);
    expect(t).toContain("run_workflow");
    expect(t).toContain('"step_id": "script"');
    expect(t).toContain('"input_schema"');
    expect(t).not.toContain("/v2/openai/v1/chat/completions");
    await s.close();
  });

  it("run_workflow: one POST with {inputs, store_output, webhook_url} + Idempotency-Key, then completed output", async () => {
    const m = mockFetch([
      { method: "POST", path: "/v2/workflows/script-voiceover/run", reply: accepted },
      { method: "GET", path: RUN_PATH, reply: run("completed", { output: { audio_url: "https://cdn.relaygpu.com/content/abc" }, total_cost_usd: 0.02 }) },
    ]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools });
    const r = await s.call("run_workflow", {
      workflow_id: "script-voiceover",
      inputs: { topic: "tides" },
      store_output: "relay1d",
      webhook_url: "https://hooks.example.com/relay",
      idempotency_key: "order-1",
      wait_seconds: 5,
    });
    expect(r.isError).toBeFalsy();
    const sent = posts(m.calls);
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ inputs: { topic: "tides" }, store_output: "relay1d", webhook_url: "https://hooks.example.com/relay" });
    expect(sent[0].headers.get("idempotency-key")).toBe("order-1");
    const body = jsonOf(r);
    expect(body).toMatchObject({ status: "completed", run_id: RUN_ID, total_cost_usd: 0.02, output: { audio_url: "https://cdn.relaygpu.com/content/abc" } });
    expect(body.next).toBeUndefined();
    expect(notesOf(r)).toContain("https://cdn.relaygpu.com/content/abc: stored as relay1d");
    await s.close();
  });

  it("run_workflow: generated Idempotency-Key when omitted; body is just {inputs}", async () => {
    const m = mockFetch([
      { method: "POST", path: "/v2/workflows/script-voiceover/run", reply: accepted },
      { method: "GET", path: RUN_PATH, reply: run("completed", { output: "done" }) },
    ]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools });
    await s.call("run_workflow", { workflow_id: "script-voiceover", inputs: { topic: "tides" } });
    const [post] = posts(m.calls);
    expect(post.body).toEqual({ inputs: { topic: "tides" } });
    expect(post.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    await s.close();
  });

  it("run_workflow: wait timeout is not an error — exactly ONE POST, run_id + the do-not-resubmit sentence, within budget", async () => {
    const m = mockFetch([
      { method: "POST", path: "/v2/workflows/script-voiceover/run", reply: accepted },
      { method: "GET", path: RUN_PATH, reply: run("running") },
    ]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools });
    const t0 = Date.now();
    const r = await s.call("run_workflow", { workflow_id: "script-voiceover", inputs: { topic: "tides" }, wait_seconds: 1 });
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.isError).toBeFalsy();
    expect(posts(m.calls)).toHaveLength(1);
    expect(DO_NOT_RESUBMIT).toBe("Do not resubmit: call check_workflow_run with this run_id"); // locked text
    expect(notesOf(r)).toContain(DO_NOT_RESUBMIT);
    expect(jsonOf(r)).toMatchObject({ status: "running", run_id: RUN_ID, next: { tool: "check_workflow_run", args: { run_id: RUN_ID } } });
    expect(elapsed).toBeLessThan(1 + 1.5);
    await s.close();
  });

  it("run_workflow wait_seconds 0: the submit only, no poll", async () => {
    const m = mockFetch([{ method: "POST", path: "/v2/workflows/script-voiceover/run", reply: accepted }]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools });
    const r = await s.call("run_workflow", { workflow_id: "script-voiceover", inputs: {}, wait_seconds: 0 });
    expect(m.calls).toHaveLength(1);
    expect(textOf(r)).toContain(DO_NOT_RESUBMIT);
    expect(jsonOf(r)).toMatchObject({ status: "queued", run_id: RUN_ID, poll_url: RUN_PATH, replayed: false, next: { tool: "check_workflow_run", args: { run_id: RUN_ID } } });
    await s.close();
  });

  it("run_workflow without a credential: MISSING_CREDENTIALS, zero requests", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools, credential: null });
    const r = await s.call("run_workflow", { workflow_id: "script-voiceover", inputs: {} });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("run_workflow: a failed run is a tool error (TaskFailedError, run id, run.error)", async () => {
    const m = mockFetch([
      { method: "POST", path: "/v2/workflows/script-voiceover/run", reply: accepted },
      { method: "GET", path: RUN_PATH, reply: run("failed", { error: "step voice failed: provider unavailable", failed_step_index: 1 }) },
    ]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools });
    const r = await s.call("run_workflow", { workflow_id: "script-voiceover", inputs: {}, wait_seconds: 5 });
    expect(r.isError).toBe(true);
    const t = textOf(r);
    expect(t).toContain("TaskFailedError");
    expect(t).toContain(`task_id: ${RUN_ID}`);
    expect(t).toContain("provider unavailable");
    await s.close();
  });

  it("check_workflow_run on a running run returns within ~wait_seconds, keyless, with the still-running sentence", async () => {
    const m = mockFetch([{ method: "GET", path: RUN_PATH, reply: run("running") }]);
    const s = await connect({ fetch: m.fetch, tools: workflowTools, credential: null });
    const t0 = Date.now();
    const r = await s.call("check_workflow_run", { run_id: RUN_ID, wait_seconds: 2 });
    const elapsed = (Date.now() - t0) / 1000;
    expect(r.isError).toBeFalsy();
    expect(elapsed).toBeLessThanOrEqual(2 + 1.5);
    expect(m.calls.every((c) => c.method === "GET" && c.path === RUN_PATH)).toBe(true);
    expect(m.calls.every((c) => c.headers.get("x-api-key") === null)).toBe(true);
    expect(notesOf(r)).toContain(STILL_RUNNING);
    const body = jsonOf(r);
    expect(body).toMatchObject({ status: "running", run_id: RUN_ID });
    expect(body.steps[0]).toEqual({ step_id: "script", model: "openai/gpt-5.4", status: "completed", task_id: "direct:aaa", cost_usd: 0.001 });
    await s.close();
  });

  it("check_workflow_run: completed → output; cancelled → tool error", async () => {
    const done = mockFetch([{ method: "GET", path: RUN_PATH, reply: run("completed", { output: { text: "hello" } }) }]);
    let s = await connect({ fetch: done.fetch, tools: workflowTools, credential: null });
    let r = await s.call("check_workflow_run", { run_id: RUN_ID, wait_seconds: 0 });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ status: "completed", run_id: RUN_ID, output: { text: "hello" } });
    expect(done.calls).toHaveLength(1);
    await s.close();

    const cancelled = mockFetch([{ method: "GET", path: RUN_PATH, reply: run("cancelled") }]);
    s = await connect({ fetch: cancelled.fetch, tools: workflowTools, credential: null });
    r = await s.call("check_workflow_run", { run_id: RUN_ID, wait_seconds: 5 });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("TaskFailedError");
    expect(textOf(r)).toContain("task_status: cancelled");
    await s.close();
  });

  it("cancel_workflow_run: POST /v2/workflows/runs/{id}/cancel with the key; ended run → WORKFLOW_RUN_NOT_CANCELLABLE", async () => {
    const m = mockFetch([{ method: "POST", path: `${RUN_PATH}/cancel`, reply: run("cancelled") }]);
    let s = await connect({ fetch: m.fetch, tools: workflowTools });
    let r = await s.call("cancel_workflow_run", { run_id: RUN_ID });
    expect(r.isError).toBeFalsy();
    expect(m.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${RUN_PATH}/cancel`]);
    expect(m.calls[0].headers.get("x-api-key")).toBe("relay_sk_unit_test_key");
    expect(textOf(r)).toContain('"status": "cancelled"');
    await s.close();

    // A live run: Relay answers it still running with cancel_requested set server-side; we say "requested" and point at the check.
    const live = mockFetch([{ method: "POST", path: `${RUN_PATH}/cancel`, reply: run("running") }]);
    s = await connect({ fetch: live.fetch, tools: workflowTools });
    r = await s.call("cancel_workflow_run", { run_id: RUN_ID });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ status: "running", cancel_requested: true, next: { tool: "check_workflow_run", args: { run_id: RUN_ID } } });
    await s.close();

    const ended = mockFetch([{ method: "POST", path: `${RUN_PATH}/cancel`, reply: apiError(409, "WORKFLOW_RUN_NOT_CANCELLABLE", "Run already completed") }]);
    s = await connect({ fetch: ended.fetch, tools: workflowTools });
    r = await s.call("cancel_workflow_run", { run_id: RUN_ID });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("code: WORKFLOW_RUN_NOT_CANCELLABLE");
    await s.close();
  });
});
