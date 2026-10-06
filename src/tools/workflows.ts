// Workflow tools: list (public), run (one submit + bounded wait), check (keyless poll), cancel.
import { z } from "zod";
import type { Relay, WorkflowRunState } from "@relaygpu/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defineTool, jsonResult, type ToolContext, type ToolDef } from "../context.js";
import { CHECK_WAIT_MAX_S, RUN_WAIT_MAX_S, asyncAnswer, doNotResubmit, failedError, stillRunning, waitOrCurrent, waitSecondsArg } from "./pending.js";

export const DO_NOT_RESUBMIT = doNotResubmit("check_workflow_run");
export const STILL_RUNNING = stillRunning("check_workflow_run");

const REPLAYED_NOTE = "This submit replayed an earlier one with the same idempotency_key: same run, nothing billed again.";

const runIdField = z.string().min(1).describe("The run id returned by run_workflow (`wf:…`).");

/** The steps without bulky outputs: what a caller needs to decide the next step. */
const stepsOf = (run: WorkflowRunState) =>
  run.steps.map((s) => ({ step_id: s.step_id, model: s.model, status: s.status, task_id: s.task_id || undefined, cost_usd: s.cost_usd ?? undefined, error: s.error || undefined }));

/** The run as the answer envelope: completed → the output through the media formatter; failed / cancelled → TaskFailedError. */
function answerRun(run: WorkflowRunState, ctx: ToolContext, notes: string[], storeOutput: string | null | undefined, replayed?: boolean): Promise<CallToolResult> {
  if (run.status === "failed" || run.status === "cancelled") throw failedError(run.run_id, run, "Workflow run");
  const info = { workflow_id: run.workflow_id, steps: stepsOf(run), total_cost_usd: run.total_cost_usd ?? undefined, replayed };
  if (run.status === "completed") {
    const sku = storeOutput && storeOutput !== "provider" ? storeOutput : undefined;
    return asyncAnswer(ctx, { status: "completed", id: { run_id: run.run_id }, info, output: { body: run.output, store: sku ? "applied" : "none", sku } });
  }
  return asyncAnswer(ctx, { status: run.status, id: { run_id: run.run_id }, info, notes, next: "check_workflow_run" });
}

/** waitRun within `ms`; past it, the current run (one extra GET, else the last state seen). */
function waitRunOrCurrent(relay: Relay, runId: string, ms: number, signal: AbortSignal): Promise<WorkflowRunState> {
  let last: WorkflowRunState | undefined;
  return waitOrCurrent(
    ms,
    (budget) => relay.workflows.waitRun(runId, { timeoutMs: budget, signal, onProgress: (r) => (last = r) }),
    () => relay.workflows.getRun(runId, { signal }).catch((e) => last ?? Promise.reject(e)),
  );
}

const list_workflows = defineTool({
  name: "list_workflows",
  title: "List workflows",
  description:
    "List Relay's workflow templates: multi-step pipelines (e.g. script → voiceover) run as one call. Each entry has " +
    "workflow_id, input_schema and its steps (step_id + model). Run one with run_workflow; inputs follow input_schema.",
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler(_args, ctx) {
    const list = await ctx.catalog.workflows.list();
    const workflows = list.workflows.map((w) => ({
      workflow_id: w.workflow_id,
      name: w.name,
      description: w.description ?? null,
      version: w.version,
      input_schema: w.input_schema ?? null,
      steps: w.steps.map((s) => ({ step_id: s.step_id, model: s.model })),
    }));
    return jsonResult({ total: list.total, workflows }, ["Run one with run_workflow; inputs follow input_schema."]);
  },
});

const run_workflow = defineTool({
  name: "run_workflow",
  title: "Run a workflow",
  description:
    `Start a workflow run (one submit) and wait up to wait_seconds (≤ ${RUN_WAIT_MAX_S}) for it to finish. Completed → ` +
    "the final output; still running → run_id: call check_workflow_run with it, never resubmit (a new run bills " +
    "again). Each step is billed as an ordinary request. webhook_url gets ONE signed workflow.completed / " +
    "workflow.failed delivery when the run ends. Get workflow_id and the inputs shape from list_workflows.",
  inputSchema: {
    workflow_id: z.string().min(1).describe("Workflow template id from list_workflows, e.g. `script-voiceover`."),
    inputs: z.record(z.unknown()).describe("Template inputs, an object matching the workflow's input_schema."),
    store_output: z
      .string()
      .optional()
      .describe("Run-level storage for every media step: `provider` (default, 1 h link) or `relay1d` / `relay7d` / `relay30d` (billed per file, see get_pricing)."),
    webhook_url: z.string().optional().describe("HTTPS URL for one signed workflow.completed / workflow.failed delivery when the run ends."),
    wait_seconds: waitSecondsArg(RUN_WAIT_MAX_S, "returns the run_id at once"),
    idempotency_key: z
      .string()
      .optional()
      .describe("Idempotency-Key for the submit: the same key and inputs within 24 h return the same run_id instead of a new run. Generated when omitted."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  billed: true,
  async handler({ workflow_id, inputs, store_output, webhook_url, wait_seconds, idempotency_key }, ctx) {
    const relay = ctx.client();
    const deadline = Date.now() + wait_seconds * 1000;
    const accepted = await relay.workflows.run(workflow_id, inputs, {
      storeOutput: store_output,
      webhookUrl: webhook_url,
      idempotencyKey: idempotency_key,
      signal: ctx.signal,
    });
    const runId = accepted.run_id;
    const notes = [DO_NOT_RESUBMIT + "."];
    if (accepted.replayed) notes.push(REPLAYED_NOTE);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return asyncAnswer(ctx, {
        status: accepted.status,
        id: { run_id: runId },
        info: { poll_url: accepted.poll_url, replayed: accepted.replayed },
        notes,
        next: "check_workflow_run",
      });
    }
    const run = await waitRunOrCurrent(relay, runId, remaining, ctx.signal);
    return answerRun(run, ctx, notes, store_output, accepted.replayed);
  },
});

const check_workflow_run = defineTool({
  name: "check_workflow_run",
  title: "Check a workflow run",
  description:
    `Poll a workflow run by run_id, waiting up to wait_seconds (≤ ${CHECK_WAIT_MAX_S}) for it to end. Completed → the ` +
    "final output; failed / cancelled → the error; still running → its steps so far: call check_workflow_run again. " +
    "No key needed: the run_id is the access token.",
  inputSchema: {
    run_id: runIdField,
    wait_seconds: waitSecondsArg(CHECK_WAIT_MAX_S, "answers the current state at once"),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler({ run_id, wait_seconds }, ctx) {
    const run = await waitRunOrCurrent(ctx.catalog, run_id, wait_seconds * 1000, ctx.signal);
    return answerRun(run, ctx, [STILL_RUNNING], run.store_output);
  },
});

const cancel_workflow_run = defineTool({
  name: "cancel_workflow_run",
  title: "Cancel a workflow run",
  description:
    "Cancel a workflow run. Cancels between steps only: a step already running completes and bills. A run that has " +
    "already ended answers WORKFLOW_RUN_NOT_CANCELLABLE.",
  inputSchema: { run_id: runIdField },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  billed: true,
  async handler({ run_id }, ctx) {
    const run = await ctx.client().workflows.cancelRun(run_id);
    // Relay only flags the run (`cancel_requested`, not on the run state): it lands in `cancelled` once the step in
    // flight finishes, so a 200 on a live run means "requested", not "done".
    const ended = run.status === "cancelled" || run.status === "completed" || run.status === "failed";
    return jsonResult(
      {
        run_id: run.run_id,
        workflow_id: run.workflow_id,
        status: run.status,
        cancel_requested: ended ? undefined : true,
        steps: stepsOf(run),
        total_cost_usd: run.total_cost_usd ?? undefined,
        error: run.error || undefined,
        next: ended ? undefined : { tool: "check_workflow_run", args: { run_id: run.run_id } },
      },
      [
        ended
          ? `Run ${run.run_id} is ${run.status}.`
          : `Cancel requested: run ${run.run_id} lands in cancelled when the step in flight finishes (that step completes and bills). Call check_workflow_run to confirm.`,
      ],
    );
  },
});

export const workflowTools: ToolDef[] = [list_workflows, run_workflow, check_workflow_run, cancel_workflow_run];
