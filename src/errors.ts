// The one mapper: SDK error → MCP tool error text. Branches on class and code only, never on message text.
import { AuthenticationError, MissingCredentialsError, RelayError, TaskFailedError } from "@relaygpu/client";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TransportKind } from "./context.js";

const DETAIL_MAX = 2_000;

/** What to set when a call needs a credential (or the one sent was refused). */
export function credentialHint(transport: TransportKind): string {
  return transport === "http"
    ? "Set the X-API-Key header (a relay_sk_ key) or Authorization: Bearer <dashboard JWT> on this MCP server's connection."
    : "Set RELAY_API_KEY (a relay_sk_ key) in this MCP server's environment.";
}

/** Thrown locally before any request when a billed tool runs without a credential (Relay would serve it as a guest). */
export function missingCredential(): MissingCredentialsError {
  return new MissingCredentialsError({
    message: "This tool needs a Relay credential and the connection carries none.",
    status: 401,
    code: "MISSING_CREDENTIALS",
  });
}

function detailText(detail: unknown): string | null {
  if (detail === undefined || detail === null) return null;
  const s = typeof detail === "string" ? detail : JSON.stringify(detail);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) + "…" : s;
}

export function errorText(e: unknown, transport: TransportKind): string {
  if (!(e instanceof RelayError)) {
    const err = e instanceof Error ? e : new Error(String(e));
    return `${err.name}: ${err.message}`;
  }
  const lines = [`${e.name}: ${e.message}`];
  if (e.code) lines.push(`code: ${e.code}`);
  if (e.status) lines.push(`status: ${e.status}`);
  if (e.requestId) lines.push(`requestId: ${e.requestId}`);
  if (e instanceof TaskFailedError) {
    lines.push(`task_id: ${e.taskId}`);
    // The terminal state (failed, or a workflow run's cancelled), so a polling agent can stop.
    const state = (e.task as { status?: unknown } | null)?.status;
    if (typeof state === "string") lines.push(`task_status: ${state}`);
  }
  if (e.retryAfter != null) lines.push(`retry_after_seconds: ${e.retryAfter}`);
  const detail = detailText(e.detail);
  if (detail && detail !== e.message) lines.push(`detail: ${detail}`);
  if (e instanceof AuthenticationError) lines.push(credentialHint(transport));
  return lines.join("\n");
}

export function toolError(e: unknown, transport: TransportKind): CallToolResult {
  return { isError: true, content: [{ type: "text", text: errorText(e, transport) }] };
}
