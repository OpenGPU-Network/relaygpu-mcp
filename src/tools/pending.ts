// Shared by the four async tools (run_model, check_task, run_workflow, check_workflow_run): the wait bounds, the
// do-not-resubmit sentences, the bounded wait, and the one answer envelope.
import { z } from "zod";
import { APITimeoutError, TaskFailedError } from "@relaygpu/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { jsonResult, type ToolContext } from "../context.js";
import { formatResult, type MediaOptions } from "../media.js";

export const RUN_WAIT_MAX_S = 45;
export const CHECK_WAIT_MAX_S = 30;

/** `wait_seconds` for a submit (`what` = what it returns at once with 0) or a check. */
export const waitSecondsArg = (max: number, what: string) =>
  z.number().int().min(0).max(max).default(max).describe(`Seconds to wait for it to finish (0–${max}, default ${max}); 0 ${what}.`);

type Poll = "check_task" | "check_workflow_run";
const idName = (tool: Poll) => (tool === "check_task" ? "task_id" : "run_id");

/** "Do not resubmit: call check_task with this task_id" (and the run_id twin). */
export const doNotResubmit = (tool: Poll) => `Do not resubmit: call ${tool} with this ${idName(tool)}`;
export const stillRunning = (tool: Poll) =>
  tool === "check_task" ? "Still running: call check_task again with this task_id; do not resubmit." : "Still running: call check_workflow_run again; do not resubmit.";

/**
 * Waits up to `waitMs` for a terminal state; past it, the current state instead of an error (the timeout's last
 * seen state when it carries one, else one more read). `waitMs` 0 just reads.
 */
export async function waitOrCurrent<T>(waitMs: number, wait: (ms: number) => Promise<T>, get: () => Promise<T>): Promise<T> {
  if (waitMs <= 0) return get();
  try {
    return await wait(waitMs);
  } catch (e) {
    if (!(e instanceof APITimeoutError)) throw e;
    return (e.detail as { task?: T } | undefined)?.task ?? get();
  }
}

/** The error `tasks.wait` / `waitRun` throw for a failed (or cancelled) state, for a state read without waiting. */
export function failedError(id: string, state: { status: string; error?: string | null; error_code?: string | null; error_detail?: unknown }, what: string): TaskFailedError {
  return new TaskFailedError({
    message: state.error || `${what} ${id} ${state.status}`,
    code: state.error_code ?? null,
    detail: state.error_detail ?? undefined,
    taskId: id,
    task: state,
  });
}

interface Answer {
  status: string;
  /** `{ task_id }` or `{ run_id }`; empty for a sync run_model answer. */
  id: { task_id?: string; run_id?: string };
  /** Extra top-level fields (poll_url, elapsed_seconds, steps, replayed, …); undefined ones are dropped. */
  info?: Record<string, unknown>;
  /** Text notes placed before the JSON (the do-not-resubmit sentence first). */
  notes?: string[];
  /** Pending: the tool to call next with this id. */
  next?: Poll;
  /** Completed: the model output, formatted for the result (re-hosted, expiry notes, inline images). */
  output?: { body: unknown } & Omit<MediaOptions, "ctx">;
}

/** The one answer envelope: `{status, task_id|run_id, …info, output, rehosted, next}` after the notes. */
export async function asyncAnswer(ctx: ToolContext, a: Answer): Promise<CallToolResult> {
  const media = a.output ? await formatResult(a.output.body, { ctx, ...a.output }) : undefined;
  const id = a.id.task_id ?? a.id.run_id;
  const envelope = {
    status: a.status,
    ...a.id,
    ...a.info,
    output: media?.output,
    rehosted: media?.rehosted.length ? media.rehosted : undefined,
    next: a.next && id ? { tool: a.next, args: { [idName(a.next)]: id } } : undefined,
  };
  const result = jsonResult(envelope, [...(a.notes ?? []), ...(media?.notes ?? [])]);
  if (media) result.content.push(...media.images);
  return result;
}
