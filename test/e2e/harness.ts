// e2e harness: hosted (in-process or child) and stdio (MCP client or raw JSON-RPC) drivers against staging.
// Never prints an env value; key checks use boolean asserts so a failure message cannot echo a key.
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { LATEST_PROTOCOL_VERSION, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startHostedServer } from "../../src/hosted.js";
import { EXPIRY_NOTE } from "../../src/media.js";
import { DO_NOT_RESUBMIT } from "../../src/tools/run.js";
import { textOf } from "../helpers/harness.js";

export { EXPIRY_NOTE, textOf };
export const RESUBMIT_NOTE = DO_NOT_RESUBMIT;

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const STDIO_BIN = fileURLToPath(new URL("../../dist/stdio.js", import.meta.url));
export const HTTP_BIN = fileURLToPath(new URL("../../dist/http.js", import.meta.url));

export const BASE_URL = process.env.RELAY_BASE_URL || "";
export const API_KEY = process.env.RELAY_API_KEY || "";
export const BUDGET_ZERO_KEY = process.env.RELAY_BUDGET_ZERO_KEY || "";
/** Keyless staging items (catalog reads) need the base URL; billed items need the key too. */
export const HAS_BASE = !!BASE_URL;
export const HAS_KEY = HAS_BASE && !!API_KEY;

export const TOOL_NAMES = [
  "search_models", "get_model", "get_pricing", "estimate_cost", "run_model", "check_task", "upload_file",
  "list_workflows", "run_workflow", "check_workflow_run", "cancel_workflow_run", "get_credits", "get_usage", "search_docs",
].sort();

/** Inputs pinned against the staging catalog (GET /v2/models/{model} request_schema, 2026-10-06). */
export const QWEN = { model: "Qwen/qwen-image", input: { prompt: "a red fox", size: "512x512" } };

/** A long tool call (run_model waits up to 45 s) must outlive the SDK's 60 s default request timeout. */
const CALL_OPTS = { timeout: 180_000 };

/** Child env: the parent's minus every RELAY_* variable, then exactly what the test passes. */
export function childEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("RELAY_")) env[k] = v;
  return { ...env, ...extra };
}

async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer()
      .once("error", () => resolve(false))
      .once("listening", () => s.close(() => resolve(true)))
      .listen(port, "0.0.0.0");
  });
}

/** In-process hosted server on PORT, else 2300 when free, else an ephemeral port. */
export async function startHosted() {
  const port = process.env.PORT ? Number(process.env.PORT) : (await portFree(2300)) ? 2300 : 0;
  return startHostedServer({ port, baseUrl: BASE_URL });
}

export interface McpHandle {
  client: Client;
  call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

function handle(client: Client, close: () => Promise<void>): McpHandle {
  return {
    client,
    call: (name, args = {}) => client.callTool({ name, arguments: args }, undefined, CALL_OPTS) as Promise<CallToolResult>,
    close,
  };
}

/** MCP client over Streamable HTTP to `${url}/mcp`, with optional request headers (the credential). */
export async function mcpHttp(url: string, headers: Record<string, string> = {}): Promise<McpHandle> {
  const client = new Client({ name: "e2e-http", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL("/mcp", url), { requestInit: { headers } }));
  return handle(client, () => client.close());
}

/** MCP client over stdio spawning `node dist/stdio.js` (or `command`), stderr captured. */
export async function mcpStdio(env: Record<string, string>, command = process.execPath, args = [STDIO_BIN], cwd = ROOT) {
  const transport = new StdioClientTransport({ command, args, env: childEnv(env), stderr: "pipe", cwd });
  let stderr = "";
  transport.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  const client = new Client({ name: "e2e-stdio", version: "0.0.0" });
  await client.connect(transport);
  return { ...handle(client, () => client.close()), stderr: () => stderr };
}

export interface RawRun {
  stdout: Buffer;
  stderr: string;
  /** Responses by request id. */
  responses: Map<number, { result?: unknown; error?: unknown }>;
}

/**
 * Drive the stdio bin with raw newline-delimited JSON-RPC (the client SDK would hide stray stdout bytes):
 * initialize, notifications/initialized, then `requests` (ids 2..n). Resolves when every request is answered.
 */
export async function rawStdio(env: Record<string, string>, requests: { method: string; params: unknown }[], timeoutMs = 120_000): Promise<RawRun> {
  const child: ChildProcess = spawn(process.execPath, [STDIO_BIN], { env: childEnv(env), stdio: ["pipe", "pipe", "pipe"] });
  const out: Buffer[] = [];
  let stderr = "";
  let pending = "";
  const responses = new Map<number, { result?: unknown; error?: unknown }>();
  const waiters = new Map<number, () => void>();
  child.stderr!.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
  child.stdout!.on("data", (c: Buffer) => {
    out.push(c);
    pending += c.toString("utf8");
    let i: number;
    while ((i = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, i);
      pending = pending.slice(i + 1);
      try {
        const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
        if (typeof msg.id === "number") {
          responses.set(msg.id, msg);
          waiters.get(msg.id)?.();
        }
      } catch {
        /* asserted by the caller over the raw bytes */
      }
    }
  });
  const send = (m: unknown) => child.stdin!.write(JSON.stringify(m) + "\n");
  const answered = (id: number) => new Promise<void>((resolve) => (responses.has(id) ? resolve() : waiters.set(id, resolve)));
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("rawStdio: timed out waiting for responses")), timeoutMs).unref());
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "e2e-raw", version: "0.0.0" } } });
    await Promise.race([answered(1), timer]);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    requests.forEach((r, i) => send({ jsonrpc: "2.0", id: i + 2, method: r.method, params: r.params }));
    await Promise.race([Promise.all(requests.map((_, i) => answered(i + 2))), timer]);
    // Let any trailing write land before the bytes are judged.
    await new Promise((r) => setTimeout(r, 200));
  } finally {
    child.stdin!.end();
    child.kill();
  }
  return { stdout: Buffer.concat(out), stderr, responses };
}

/** Hosted server as a child (`node dist/http.js`) so its stderr can be captured; resolves on `http_listening`. */
export async function hostedChild(env: Record<string, string>) {
  const child = spawn(process.execPath, [HTTP_BIN], { env: childEnv({ PORT: "0", ...env }), stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  let stdout = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
  const url = await new Promise<string>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("hostedChild: no http_listening line within 30 s")), 30_000);
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
      for (const line of stderr.split("\n")) {
        try {
          const j = JSON.parse(line) as { msg?: string; url?: string };
          if (j.msg === "http_listening" && j.url) {
            clearTimeout(t);
            resolve(j.url);
          }
        } catch {
          /* partial line */
        }
      }
    });
    child.once("exit", (code) => reject(new Error(`hostedChild exited early (code ${code})`)));
  });
  return {
    url,
    stderr: () => stderr,
    stdout: () => stdout,
    close: () => new Promise<void>((resolve) => (child.exitCode !== null ? resolve() : (child.once("exit", () => resolve()), child.kill()))),
  };
}

function deepFind(v: unknown, key: string): unknown {
  if (!v || typeof v !== "object") return undefined;
  if (!Array.isArray(v) && key in v) return (v as Record<string, unknown>)[key];
  for (const child of Object.values(v)) {
    const hit = deepFind(child, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** A field from a tool answer (the envelope's top-level `status` / `task_id` / `run_id` first), else a `key: value` match. */
export function fieldOf(r: CallToolResult, key: string): string | undefined {
  for (const c of r.content) {
    if (c.type !== "text") continue;
    try {
      const hit = deepFind(JSON.parse(c.text), key);
      if (hit !== undefined && hit !== null) return String(hit);
    } catch {
      /* not JSON */
    }
  }
  const m = new RegExp(`"?${key}"?\\s*[:=]\\s*"?([\\w:./-]+)`).exec(textOf(r));
  return m?.[1];
}

export const URL_RE = /https?:\/\/[^\s"')]+/;

/** 0.5 s of 8 kHz mono 16-bit PCM (a 440 Hz tone) as a wav. */
export function tinyWav(): Buffer {
  const rate = 8000;
  const samples = rate / 2;
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
