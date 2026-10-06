// A3 (F3, F4) against staging: Qwen → image URL + expiry note; Kling (wait 10 s) → task_id + do-not-resubmit, then
// check_task loops to the result; unknown and retired models fail with their codes. Billed: one image, one 3 s std video.
// The "zero POSTs before the refusal" half of A3 is fixture-pinned in the unit suite, not provable here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, BASE_URL, EXPIRY_NOTE, HAS_KEY, QWEN, RESUBMIT_NOTE, URL_RE, fieldOf, mcpHttp, startHosted, textOf, type McpHandle } from "./harness.js";

const KLING = {
  model: "KlingTeam/v3-T2V",
  input: { prompt: "a paper boat drifting on a calm pond", duration: 3, quality_mode: "std" },
  wait_seconds: 10,
};
const RETIRED_CANDIDATE = "black-forest-labs/FLUX.2-klein-4B";

describe.skipIf(!HAS_KEY)("A3 run_model", () => {
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let mcp: McpHandle;

  beforeAll(async () => {
    hosted = await startHosted();
    mcp = await mcpHttp(hosted.url, { "X-API-Key": API_KEY });
  });
  afterAll(async () => {
    await mcp?.close();
    await hosted?.close();
  });

  it("A3 Qwen/qwen-image returns an image URL with the expiry note (1 billed image)", async () => {
    const r = await mcp.call("run_model", QWEN);
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(textOf(r)).toMatch(URL_RE);
    expect(textOf(r)).toContain(EXPIRY_NOTE);
  });

  it("A3 KlingTeam/v3-T2V wait_seconds=10 → task_id + do-not-resubmit; check_task loops to the result (1 billed video)", async () => {
    const submitted = await mcp.call("run_model", KLING);
    expect(submitted.isError, textOf(submitted)).toBeFalsy();
    expect(textOf(submitted)).toContain(RESUBMIT_NOTE);
    const taskId = fieldOf(submitted, "task_id");
    expect(taskId).toMatch(/^(direct|opengpu):/);

    let last = submitted;
    let status = "";
    for (let i = 0; i < 12 && status !== "completed"; i++) {
      last = await mcp.call("check_task", { task_id: taskId, wait_seconds: 30 });
      expect(last.isError, textOf(last)).toBeFalsy();
      status = fieldOf(last, "status") ?? "";
      expect(status).not.toBe("failed");
    }
    expect(status).toBe("completed");
    expect(textOf(last)).toMatch(URL_RE);
  });

  it("A3 an unknown model fails with MODEL_NOT_FOUND", async () => {
    const r = await mcp.call("run_model", { model: "nope/does-not-exist", input: { prompt: "x" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MODEL_NOT_FOUND");
  });

  it("A3 a retired model fails with MODEL_RETIRED", async (ctx) => {
    const res = await fetch(`${BASE_URL}/v2/models/${RETIRED_CANDIDATE}`);
    const status = res.ok ? ((await res.json()) as { status?: string }).status : undefined;
    if (status !== "retired") ctx.skip(); // no known retired model on this env: nothing to prove
    const r = await mcp.call("run_model", { model: RETIRED_CANDIDATE, input: { inputs: "a red fox" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MODEL_RETIRED");
  });
});
