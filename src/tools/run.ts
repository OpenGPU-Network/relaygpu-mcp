// run_model (one submit, bounded wait, task_id past the window) and check_task (keyless poll).
import { z } from "zod";
import { isAccepted, type TaskStatus } from "@relaygpu/client";
import { defineTool, type ToolDef } from "../context.js";
import type { Store } from "../media.js";
import { CHECK_WAIT_MAX_S, RUN_WAIT_MAX_S, asyncAnswer, doNotResubmit, failedError, stillRunning, waitOrCurrent, waitSecondsArg } from "./pending.js";

export const DO_NOT_RESUBMIT = doNotResubmit("check_task");
export const STILL_RUNNING = stillRunning("check_task");

const inlineImagesArg = z
  .boolean()
  .optional()
  .describe("Also return images ≤ 1 MB as image content blocks (default false: links only).");

const run_model = defineTool({
  name: "run_model",
  title: "Run a Relay model",
  description:
    "Runs any Relay model by name (billed to your key). input follows get_model's request_schema (request_example " +
    `runs as is). Waits up to ${RUN_WAIT_MAX_S} s; past that it returns a task_id — do not resubmit, call check_task. Result links ` +
    "expire 1 h after completion unless store_output names a media_storage SKU from get_pricing. Pass an " +
    "idempotency_key if you may retry the same submit.",
  inputSchema: {
    model: z.string().describe("Exact model name from search_models / get_model, e.g. Qwen/qwen-image."),
    input: z.record(z.unknown()).describe("Request body per get_model's request_schema, without model (added for you). Pass media as *_url links (upload_file makes one)."),
    store_output: z
      .string()
      .optional()
      .describe("Keep result media longer: a media_storage SKU from get_pricing (e.g. relay7d, adds its per-file fee), or provider (default, 1 h)."),
    wait_seconds: waitSecondsArg(RUN_WAIT_MAX_S, "returns the task_id at once"),
    idempotency_key: z.string().optional().describe("Your key for this submit: a retry with the same key replays the first task instead of starting (and billing) a new one."),
    inline_images: inlineImagesArg,
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  billed: true,
  async handler({ model, input, store_output, wait_seconds, idempotency_key, inline_images }, ctx) {
    const deadline = Date.now() + wait_seconds * 1000;
    // Unknown → ModelNotFoundError here; retired → the SDK's ModelRetiredError from client.run. Both before any POST.
    const detail = await ctx.catalog.models.get(model);
    const forward = Boolean(store_output) && detail.store_output_supported === true;
    const sku = store_output && store_output !== "provider" ? store_output : undefined;
    const store: Store = !sku ? "none" : forward ? "applied" : "unsupported";
    const media = { store, sku, inlineImages: inline_images };

    const client = ctx.client();
    const res = await client.run(model, input, {
      wait: false,
      storeOutput: forward ? store_output : undefined,
      idempotencyKey: idempotency_key,
      signal: ctx.signal,
    });
    if (!isAccepted(res)) return asyncAnswer(ctx, { status: "completed", id: {}, output: { body: res, ...media } });

    const id = { task_id: res.task_id };
    const pending = (task?: TaskStatus) =>
      asyncAnswer(ctx, {
        status: task?.status ?? res.status ?? "queued",
        id,
        info: { poll_url: res.poll_url, elapsed_seconds: task?.elapsed_seconds, replayed: res.replayed },
        notes: [`${DO_NOT_RESUBMIT}.`],
        next: "check_task",
      });
    const remaining = deadline - Date.now();
    if (remaining <= 0) return pending();
    const task = await waitOrCurrent(
      remaining,
      (ms) => client.tasks.wait(res.task_id, { timeoutMs: ms, signal: ctx.signal }),
      () => client.tasks.get(res.task_id, { signal: ctx.signal }),
    );
    if (task.status === "failed") throw failedError(res.task_id, task, "Task");
    if (task.status !== "completed") return pending(task);
    return asyncAnswer(ctx, { status: "completed", id, output: { body: task.result ?? {}, ...media } });
  },
});

const check_task = defineTool({
  name: "check_task",
  title: "Check a Relay task",
  description:
    `Checks a task run_model returned (no key needed: the task_id is the capability). Waits up to ${CHECK_WAIT_MAX_S} s for it to ` +
    "finish; returns the result when completed, else its status: then call check_task again, never resubmit. " +
    "Task results are kept 1 h after they finish.",
  inputSchema: {
    task_id: z.string().describe("The task_id from run_model, e.g. direct:2f9c…"),
    wait_seconds: waitSecondsArg(CHECK_WAIT_MAX_S, "just reads the status"),
    inline_images: inlineImagesArg,
  },
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: true },
  async handler({ task_id, wait_seconds, inline_images }, ctx) {
    const task = await waitOrCurrent(
      wait_seconds * 1000,
      (ms) => ctx.catalog.tasks.wait(task_id, { timeoutMs: ms, signal: ctx.signal }),
      () => ctx.catalog.tasks.get(task_id, { signal: ctx.signal }),
    );
    // tasks.wait throws this itself; a read without waiting gets the same error here.
    if (task.status === "failed") throw failedError(task_id, task, "Task");
    const id = { task_id };
    if (task.status === "completed") return asyncAnswer(ctx, { status: "completed", id, output: { body: task.result ?? {}, inlineImages: inline_images } });
    return asyncAnswer(ctx, { status: task.status, id, info: { elapsed_seconds: task.elapsed_seconds }, notes: [STILL_RUNNING], next: "check_task" });
  },
});

export const runTools: ToolDef[] = [run_model, check_task];
