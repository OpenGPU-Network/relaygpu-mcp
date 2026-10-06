// A6 (F3): list_workflows; run_workflow("script-voiceover", wait_seconds=45) to a completed run; a bounded
// check_workflow_run(wait_seconds=10) on a RUNNING run; cancel_workflow_run on a fresh run. At most 2 billed runs:
//   run A — waited to completion. If A is still running after its 45 s window, the 10 s check is measured on A.
//   run B — submitted with the shortest wait. If A could not host the 10 s check, it is measured on B (B may then
//           finish its first step before the cancel); otherwise B is cancelled at once, before its first step.
// The cancel accepts `cancelled` or WORKFLOW_RUN_NOT_CANCELLABLE (B raced to its end); the outcome is logged.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, BASE_URL, HAS_KEY, fieldOf, mcpHttp, startHosted, textOf, type McpHandle } from "./harness.js";

const WORKFLOW = "script-voiceover";
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

describe.skipIf(!HAS_KEY)("A6 workflows", () => {
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let mcp: McpHandle;
  let inputs: Record<string, unknown>;
  let timedOnA = false;

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

  /** check_workflow_run(wait 10) on a running run: answers within ~10 s (+3 s slack for the round trip). */
  async function timedCheck(runId: string) {
    const t0 = Date.now();
    const r = await mcp.call("check_workflow_run", { run_id: runId, wait_seconds: 10 });
    const seconds = (Date.now() - t0) / 1000;
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(seconds).toBeLessThanOrEqual(13);
    console.info(`[A6] check_workflow_run(wait_seconds=10) answered in ${seconds.toFixed(1)} s, status=${fieldOf(r, "status")}`);
    return r;
  }

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
    if (!TERMINAL.has(status)) {
      timedOnA = true;
      status = fieldOf(await timedCheck(runId!), "status") ?? "";
      // Follow to the end, capped ~3 min.
      for (let i = 0; i < 6 && !TERMINAL.has(status); i++) {
        const c = await mcp.call("check_workflow_run", { run_id: runId, wait_seconds: 30 });
        expect(c.isError, textOf(c)).toBeFalsy();
        status = fieldOf(c, "status") ?? "";
      }
    }
    expect(status).toBe("completed");
  });

  it("A6 a fresh run: bounded check (if not done on A) then cancel_workflow_run (billed run B)", async () => {
    const r = await mcp.call("run_workflow", { workflow_id: WORKFLOW, inputs, wait_seconds: 1 });
    expect(r.isError, textOf(r)).toBeFalsy();
    const runId = fieldOf(r, "run_id");
    expect(runId).toBeTruthy();
    if (!timedOnA) await timedCheck(runId!);

    const c = await mcp.call("cancel_workflow_run", { run_id: runId });
    const text = textOf(c);
    if (c.isError) {
      expect(text).toContain("WORKFLOW_RUN_NOT_CANCELLABLE");
      console.info("[A6] cancel outcome: WORKFLOW_RUN_NOT_CANCELLABLE (run B reached its end first)");
    } else {
      expect(fieldOf(c, "status")).toBe("cancelled");
      console.info(`[A6] cancel outcome: cancelled (10 s check measured on run ${timedOnA ? "A" : "B"})`);
    }
  });
});
