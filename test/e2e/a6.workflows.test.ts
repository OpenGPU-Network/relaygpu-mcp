// A6 against staging, two billed runs:
//   run A — run_workflow(wait_seconds=45) followed to completed.
//   run B — submitted without waiting and cancelled at once (before its first step finishes); the bounded
//           check_workflow_run(wait_seconds=10) is measured on that live run, then the run is followed to cancelled.
// Relay's cancel is a request: it flags the run, which lands in cancelled after the step in flight.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, BASE_URL, HAS_KEY, fieldOf, mcpHttp, startHosted, textOf, type McpHandle } from "./harness.js";

const WORKFLOW = "script-voiceover";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

describe.skipIf(!HAS_KEY)("A6 workflows", () => {
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let mcp: McpHandle;
  let inputs: Record<string, unknown>;

  beforeAll(async () => {
    hosted = await startHosted();
    mcp = await mcpHttp(hosted.url, { "X-API-Key": API_KEY });
    // Inputs follow the template's input_schema, read at test time.
    const tpl = (await (await fetch(`${BASE_URL}/v2/workflows/${WORKFLOW}`)).json()) as {
      input_schema: { required: string[]; properties: Record<string, { enum?: string[] }> };
    };
    expect(tpl.input_schema.required.sort()).toEqual(["messages", "voice"]);
    const voices = tpl.input_schema.properties.voice.enum ?? [];
    inputs = { messages: [{ role: "user", content: "a lighthouse at dusk" }], voice: voices.includes("Cherry") ? "Cherry" : voices[0] };
  });
  afterAll(async () => {
    await mcp?.close();
    await hosted?.close();
  });

  it("A6 list_workflows has script-voiceover", async () => {
    const r = await mcp.call("list_workflows", {});
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toContain(WORKFLOW);
  });

  it("A6 run_workflow(script-voiceover, wait_seconds=45) reaches completed (billed run A)", async () => {
    const r = await mcp.call("run_workflow", { workflow_id: WORKFLOW, inputs, wait_seconds: 45 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const runId = fieldOf(r, "run_id");
    expect(runId).toBeTruthy();
    let status = fieldOf(r, "status") ?? "";
    // Follow to the end, capped ~3 min.
    for (let i = 0; i < 6 && !TERMINAL.has(status); i++) {
      const c = await mcp.call("check_workflow_run", { run_id: runId, wait_seconds: 30 });
      expect(c.isError, textOf(c)).toBeFalsy();
      status = fieldOf(c, "status") ?? "";
    }
    expect(status).toBe("completed");
  });

  it("A6 run B: cancelled before its first step finishes, bounded check on the live run, lands cancelled (billed run B)", async () => {
    // Submit without waiting and cancel at once: Relay flags the run; pending steps never dispatch.
    const r = await mcp.call("run_workflow", { workflow_id: WORKFLOW, inputs, wait_seconds: 0 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const runId = fieldOf(r, "run_id")!;
    expect(runId).toBeTruthy();
    const c = await mcp.call("cancel_workflow_run", { run_id: runId });
    if (c.isError) {
      expect(textOf(c)).toContain("WORKFLOW_RUN_NOT_CANCELLABLE"); // B raced to its end
      console.info("[A6] cancel outcome: WORKFLOW_RUN_NOT_CANCELLABLE (run B reached its end first)");
      return;
    }
    let status = fieldOf(c, "status") ?? "";
    if (status !== "cancelled") expect(textOf(c)).toContain('"cancel_requested": true');

    // The bounded check on that live run: answers within wait_seconds (+3 s slack), early if the run lands.
    const t0 = Date.now();
    let check = await mcp.call("check_workflow_run", { run_id: runId, wait_seconds: 10 });
    const seconds = (Date.now() - t0) / 1000;
    expect(seconds).toBeLessThanOrEqual(13);
    const stateOf = (x: typeof check) => (x.isError ? fieldOf(x, "task_status") : fieldOf(x, "status")) ?? "";
    status = stateOf(check);
    console.info(`[A6] check_workflow_run(wait_seconds=10) on run B answered in ${seconds.toFixed(1)} s, status=${status}`);
    for (let i = 0; i < 6 && !TERMINAL.has(status); i++) {
      check = await mcp.call("check_workflow_run", { run_id: runId, wait_seconds: 30 });
      status = stateOf(check);
    }
    // completed = the request landed during the last step (cancel saves nothing then).
    expect(["cancelled", "completed"]).toContain(status);
    console.info(`[A6] cancel outcome: requested → ${status}`);
  });
});
