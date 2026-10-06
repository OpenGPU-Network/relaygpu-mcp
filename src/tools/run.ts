// run_model (one submit, bounded wait, task_id past the window) and check_task (keyless poll).
import { z } from "zod";
import { APITimeoutError, ModelRetiredError, TaskFailedError, isAccepted, type TaskStatus } from "@relaygpu/client";
import { defineTool, jsonResult, type ToolDef } from "../context.js";
import { formatResult } from "../media.js";

export const DO_NOT_RESUBMIT = "Do not resubmit: call check_task with this task_id";
export const STILL_RUNNING = "Still running: call check_task again with this task_id; do not resubmit.";

const RUN_WAIT_MAX_S = 45;
const CHECK_WAIT_MAX_S = 30;

const inlineImagesArg = z
  .boolean()
  .optional()
  .describe("Also return images ≤ 1 MB as image content blocks (default false: links only).");

const run_model = defineTool({
  name: "run_model",
  title: "Run a Relay model",
  description:
    "Runs any Relay model by name (billed to your key). input follows get_model's request_schema (request_example " +
    "runs as is). Waits up to 45 s; past that it returns a task_id — do not resubmit, call check_task. Result links " +
    "expire 1 h after completion unless store_output names a media_storage SKU from get_pricing. Pass an " +
    "idempotency_key if you may retry the same submit.",
  inputSchema: {
    model: z.string().describe("Exact model name from search_models / get_model, e.g. Qwen/qwen-image."),
    input: z.record(z.unknown()).describe("Request body per get_model's request_schema, without model (added for you). Pass media as *_url links (upload_file makes one)."),
    store_output: z
      .string()
      .optional()
      .describe("Keep result media longer: a media_storage SKU from get_pricing (e.g. relay7d, adds its per-file fee), or provider (default, 1 h)."),
    wait_seconds: z.number().int().min(0).max(RUN_WAIT_MAX_S).optional().describe("Seconds to wait for an async task before returning its task_id (0–45, default 45)."),
    idempotency_key: z.string().optional().describe("Your key for this submit: a retry with the same key replays the first task instead of starting (and billing) a new one."),
    inline_images: inlineImagesArg,
  },
  annotations: { title: "Run a Relay model", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const { model, input, store_output, idempotency_key, inline_images } = args;
    const waitSeconds = args.wait_seconds ?? RUN_WAIT_MAX_S;
    // Unknown → ModelNotFoundError, retired → ModelRetiredError, both before anything is submitted.
    const detail = await ctx.catalog.models.get(model);
    if (detail.status === "retired") {
      throw new ModelRetiredError({ message: `Model '${model}' is retired and no longer served`, status: 403, code: "MODEL_RETIRED" });
    }
    const client = ctx.client();
    const storeApplied = Boolean(store_output) && detail.store_output_supported === true;
    const media = { ctx, storeOutput: store_output, storeOutputApplied: storeApplied, inlineImages: inline_images };

    const deadline = Date.now() + waitSeconds * 1000;
    const res = await client.run(model, input, {
      wait: false,
      storeOutput: storeApplied ? store_output : undefined,
      idempotencyKey: idempotency_key,
      signal: ctx.signal,
    });
    if (!isAccepted(res)) return formatResult(res, media);

    const pending = (status: string) =>
      jsonResult({ task_id: res.task_id, poll_url: res.poll_url, status, replayed: res.replayed }, [`${DO_NOT_RESUBMIT}.`]);
    const remaining = deadline - Date.now();
    if (remaining <= 0) return pending(res.status ?? "queued");
    try {
      const task = await client.tasks.wait(res.task_id, { timeoutMs: remaining, signal: ctx.signal });
      return formatResult(task.result ?? {}, { ...media, notes: [`task_id: ${res.task_id} (completed)`] });
    } catch (e) {
      if (e instanceof APITimeoutError) return pending(lastStatus(e) ?? res.status ?? "queued");
      throw e;
    }
  },
});

/** The task's last seen status from a `tasks.wait` timeout. */
function lastStatus(e: APITimeoutError): string | undefined {
  const task = (e.detail as { task?: TaskStatus } | undefined)?.task;
  return task?.status;
}

const check_task = defineTool({
  name: "check_task",
  title: "Check a Relay task",
  description:
    "Checks a task run_model returned (no key needed: the task_id is the capability). Waits up to 30 s for it to " +
    "finish; returns the result when completed, else its status: then call check_task again, never resubmit. " +
    "Task results are kept 1 h after they finish.",
  inputSchema: {
    task_id: z.string().describe("The task_id from run_model, e.g. direct:2f9c…"),
    wait_seconds: z.number().int().min(0).max(CHECK_WAIT_MAX_S).optional().describe("Seconds to wait for the task to finish (0–30, default 30; 0 = just read the status)."),
    inline_images: inlineImagesArg,
  },
  annotations: { title: "Check a Relay task", readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler(args, ctx) {
    const { task_id, inline_images } = args;
    const waitSeconds = args.wait_seconds ?? CHECK_WAIT_MAX_S;
    let task: TaskStatus;
    if (waitSeconds === 0) {
      task = await ctx.catalog.tasks.get(task_id, { signal: ctx.signal });
    } else {
      try {
        task = await ctx.catalog.tasks.wait(task_id, { timeoutMs: waitSeconds * 1000, signal: ctx.signal });
      } catch (e) {
        if (!(e instanceof APITimeoutError)) throw e;
        const seen = (e.detail as { task?: TaskStatus } | undefined)?.task;
        task = seen ?? (await ctx.catalog.tasks.get(task_id, { signal: ctx.signal }));
      }
    }
    if (task.status === "failed") {
      // The same error tasks.wait throws, for a status read without waiting.
      throw new TaskFailedError({
        message: task.error || `Task ${task_id} failed`,
        code: task.error_code ?? null,
        detail: task.error_detail ?? undefined,
        taskId: task_id,
        task,
      });
    }
    if (task.status === "completed") {
      return formatResult(task.result ?? {}, { ctx, inlineImages: inline_images, notes: [`task_id: ${task_id} (completed)`] });
    }
    return jsonResult({ task_id, status: task.status, elapsed_seconds: task.elapsed_seconds }, [STILL_RUNNING]);
  },
});

export const runTools: ToolDef[] = [run_model, check_task];
