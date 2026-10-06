// One server implementation for both transports: a McpServer factory over a credential resolved by the entry point
// (environment on stdio, request headers on hosted). Tools never see the credential, only `ctx.client()`.
import { Relay, DEFAULT_BASE_URL } from "@relaygpu/client";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Credential, ToolContext, ToolDef, TransportKind } from "./context.js";
import { missingCredential, toolError } from "./errors.js";
import { log } from "./log.js";
import { recordToolCall } from "./metrics.js";
import { ALL_TOOLS } from "./tools/index.js";
import { VERSION } from "./version.js";

export { VERSION };
export type { Credential, ToolContext, ToolDef, TransportKind };

export const SERVER_NAME = "relaygpu";
export const SERVER_INSTRUCTIONS =
  "Relay runs image, video, audio and other models by name. Find a model with search_models, read its input schema " +
  "with get_model, then call run_model. Long tasks return a task_id: call check_task with it, never resubmit. Result " +
  "links expire (1 h by default); store_output buys longer storage.";

export interface ServerOptions {
  transport: TransportKind;
  /** The caller's credential, or null (keyless tools still work). */
  credential?: Credential | null;
  /** Default `https://relaygpu.com`. */
  baseUrl?: string;
  /** Test seam: the fetch every SDK client uses. */
  fetch?: typeof fetch;
  /** Test seam: the tool set (default: all 14). */
  tools?: ToolDef[];
}

// One keyless client per base URL: its model cache is shared by every caller, never keyed by credential.
const catalogs = new Map<string, Relay>();

function catalogFor(baseUrl: string, fetchImpl?: typeof fetch): Relay {
  if (fetchImpl) return new Relay({ baseUrl, fetch: fetchImpl }); // test seam: never shared
  let c = catalogs.get(baseUrl);
  if (!c) catalogs.set(baseUrl, (c = new Relay({ baseUrl })));
  return c;
}

/** The caller's client, reading the catalog (models, pricing) through the shared keyless one. */
function callerClient(credential: Credential, baseUrl: string, catalog: Relay, fetchImpl?: typeof fetch): Relay {
  const client = new Relay({ ...credential, baseUrl, fetch: fetchImpl });
  // The SDK has no seam to inject a model cache; its catalog properties are plain fields.
  Object.defineProperty(client, "models", { value: catalog.models });
  Object.defineProperty(client, "pricing", { value: catalog.pricing });
  return client;
}

const KEY_PATTERN = /relay_sk_[A-Za-z0-9_-]+/g;

/** Last line of defence: no credential string leaves in a tool result. */
function scrub(result: CallToolResult, secrets: string[]): CallToolResult {
  for (const block of result.content) {
    if (block.type !== "text") continue;
    let t = block.text.replace(KEY_PATTERN, "relay_sk_[redacted]");
    for (const s of secrets) if (s) t = t.split(s).join("[redacted]");
    block.text = t;
  }
  return result;
}

export function createRelayMcpServer(opts: ServerOptions): McpServer {
  const baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const catalog = catalogFor(baseUrl, opts.fetch);
  const credential = opts.credential && (opts.credential.apiKey || opts.credential.jwt) ? opts.credential : null;
  const secrets = credential ? [credential.apiKey ?? "", credential.jwt ?? ""] : [];
  let client: Relay | undefined;

  const server = new McpServer({ name: SERVER_NAME, version: VERSION }, { instructions: SERVER_INSTRUCTIONS });

  for (const tool of opts.tools ?? ALL_TOOLS) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations },
      async (args: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const ctx: ToolContext = {
          transport: opts.transport,
          catalog,
          signal: extra.signal,
          client() {
            if (!credential) throw missingCredential();
            return (client ??= callerClient(credential, baseUrl, catalog, opts.fetch));
          },
        };
        const started = performance.now();
        let result: CallToolResult;
        try {
          result = await tool.handler(args as never, ctx);
        } catch (e) {
          result = toolError(e, opts.transport);
        }
        const outcome = result.isError ? "error" : "ok";
        const elapsed = (performance.now() - started) / 1000;
        recordToolCall(tool.name, outcome, elapsed);
        log("info", "tool_call", { tool: tool.name, outcome, seconds: +elapsed.toFixed(3) });
        return scrub(result, secrets);
      },
    );
  }
  return server;
}
