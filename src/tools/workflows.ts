// Workflow tools: list (public), run (one submit + bounded wait), check (keyless poll), cancel.
import { z } from "zod";
import { APITimeoutError, TaskFailedError, type Relay, type WorkflowRunState } from "@relaygpu/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { defineTool, jsonResult, type ToolContext, type ToolDef } from "../context.js";
import { formatResult } from "../media.js";

export const RUN_WAIT_MAX_S = 45;
export const CHECK_WAIT_MAX_S = 30;
export const DO_NOT_RESUBMIT = "Do not resubmit: call check_workflow_run with this run_id";
export const STILL_RUNNING = "Still running: call check_workflow_run again; do not resubmit.";

const runIdField = z.string().min(1).describe("The run id returned by run_workflow (`wf:…`).");

/** The run without bulky step outputs: what a caller needs to decide the next step. */
function runSummary(run: WorkflowRunState) {
  return {
    run_id: run.run_id,
    workflow_id: run.workflow_id,
    status: run.status,
    steps: run.steps.map((s) => ({
      step_id: s.step_id,
      model: s.model,
      status: s.status,
      ...(s.task_id ? { task_id: s.task_id } : {}),
      ...(s.cost_usd != null ? { cost_usd: s.cost_usd } : {}),
      ...(s.error ? { error: s.error } : {}),
    })),
    ...(run.total_cost_usd != null ? { total_cost_usd: run.total_cost_usd } : {}),
    ...(run.error ? { error: run.error } : {}),
  };
}

function stepLine(run: WorkflowRunState): string {
  return "steps: " + run.steps.map((s) => `${s.step_id} (${s.model}) ${s.status}`).join("; ");
}

/**
 * A run state as the tool answer (`storeOutput`: the run's store_output, as asked or as the run records it): completed → the output through the media formatter; failed / cancelled → the
 * SDK's TaskFailedError (as waitRun throws it); otherwise the in-progress summary under `notes`.
 */
async function answerRun(run: WorkflowRunState, ctx: ToolContext, pending: string[], storeOutput: string | undefined): Promise<CallToolResult> {
  if (run.status === "completed") {
    const notes = [`run_id: ${run.run_id}`, `status: completed`, stepLine(run)];
    if (run.total_cost_usd != null) notes.push(`total_cost_usd: ${run.total_cost_usd}`);
    return formatResult(run.output, { ctx, storeOutput, storeOutputApplied: Boolean(storeOutput), notes });
  }
  if (run.status === "failed" || run.status === "cancelled") {
    throw new TaskFailedError({ message: run.error || `Workflow run ${run.status}`, taskId: run.run_id, task: run });
  }
  return jsonResult({ ...runSummary(run), poll: { tool: "check_workflow_run", run_id: run.run_id } }, pending);
}

/** waitRun within `ms`; on budget exhaustion, the current run (one extra GET) instead of an error. */
async function waitOrCurrent(relay: Relay, runId: string, ms: number, signal: AbortSignal): Promise<WorkflowRunState> {
  let last: WorkflowRunState | undefined;
  try {
    return await relay.workflows.waitRun(runId, { timeoutMs: ms, signal, onProgress: (r) => (last = r) });
  } catch (e) {
    if (!(e instanceof APITimeoutError)) throw e;
    try {
      return await relay.workflows.getRun(runId, { signal });
    } catch (e2) {
      if (last) return last;
      throw e2;
    }
  }
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
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(RUN_WAIT_MAX_S)
      .default(RUN_WAIT_MAX_S)
      .describe(`Seconds to wait for the run to end (0–${RUN_WAIT_MAX_S}, default ${RUN_WAIT_MAX_S}); 0 returns the run_id at once.`),
    idempotency_key: z
      .string()
      .optional()
      .describe("Idempotency-Key for the submit: the same key and inputs within 24 h return the same run_id instead of a new run. Generated when omitted."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
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
    const pending = [`run_id: ${runId}`, DO_NOT_RESUBMIT + "."];
    if (accepted.replayed) pending.push("This submit replayed an earlier one with the same idempotency_key: same run, nothing billed again.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return jsonResult({ run_id: runId, status: accepted.status, poll: { tool: "check_workflow_run", run_id: runId } }, pending);
    }
    const run = await waitOrCurrent(relay, runId, remaining, ctx.signal);
    return answerRun(run, ctx, [`Run ${runId} is ${run.status} after ${wait_seconds} s.`, ...pending], store_output);
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
    wait_seconds: z
      .number()
      .int()
      .min(0)
      .max(CHECK_WAIT_MAX_S)
      .default(CHECK_WAIT_MAX_S)
      .describe(`Seconds to wait for the run to end (0–${CHECK_WAIT_MAX_S}, default ${CHECK_WAIT_MAX_S}); 0 answers the current state at once.`),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  async handler({ run_id, wait_seconds }, ctx) {
    const run =
      wait_seconds > 0
        ? await waitOrCurrent(ctx.catalog, run_id, wait_seconds * 1000, ctx.signal)
        : await ctx.catalog.workflows.getRun(run_id, { signal: ctx.signal });
    return answerRun(run, ctx, [STILL_RUNNING], run.store_output ?? undefined);
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
  async handler({ run_id }, ctx) {
    const run = await ctx.client().workflows.cancelRun(run_id);
    return jsonResult(runSummary(run), [`Run ${run.run_id} is ${run.status}. A step that was already running completes and bills.`]);
  },
});

export const workflowTools: ToolDef[] = [list_workflows, run_workflow, check_workflow_run, cancel_workflow_run];
