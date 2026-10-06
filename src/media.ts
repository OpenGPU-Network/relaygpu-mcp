// D7 media-out formatting, shared by run_model, check_task, run_workflow and check_workflow_run.
// STUB (lead): package (a) replaces the body; the signature is the contract package (b) builds on.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";
import { jsonResult } from "./context.js";

export const EXPIRY_NOTE = "expires 1 h after completion unless store_output was set";

export interface MediaOptions {
  ctx: ToolContext;
  /** What the caller asked for (`provider`, `relay1d`, …), if anything. */
  storeOutput?: string;
  /** True when store_output was forwarded to the route (the model's `store_output_supported`). */
  storeOutputApplied?: boolean;
  /** Add MCP image content blocks for images ≤ 1 MB. */
  inlineImages?: boolean;
  /** Text lines placed before the JSON (e.g. task_id, status). */
  notes?: string[];
}

/** Formats a model output (sync body, task result or run output): URLs with expiry notes, base64 re-hosted, never inlined unless asked. */
export async function formatResult(body: unknown, opts: MediaOptions): Promise<CallToolResult> {
  return jsonResult(body, [...(opts.notes ?? []), `Media links ${EXPIRY_NOTE}.`]);
}
