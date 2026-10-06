// The contract between the server and the tool modules (src/tools/*). A tool module exports `ToolDef[]`.
import type { Relay } from "@relaygpu/client";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { z, ZodRawShape } from "zod";

export type TransportKind = "stdio" | "http";

/** The caller's Relay credential: a key (`X-API-Key`) or a dashboard JWT (`Authorization: Bearer`). */
export interface Credential {
  apiKey?: string;
  jwt?: string;
}

export interface ToolContext {
  transport: TransportKind;
  /** The shared keyless client: catalog reads (`models`, `pricing`), task and run polls. Never carries a credential. */
  catalog: Relay;
  /**
   * The caller's client for billed and account calls. Its `models`/`pricing` are the shared catalog's (one model
   * cache per base URL, never per key). Throws `MissingCredentialsError` when the connection carries no credential.
   */
  client(): Relay;
  /** Aborted when the MCP request is cancelled. */
  signal: AbortSignal;
}

export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** zod raw shape; every field carries `.describe()`. */
  inputSchema: S;
  annotations?: ToolAnnotations;
  handler(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext): Promise<CallToolResult>;
}

/** Identity helper that keeps the handler's argument type tied to its schema. */
export function defineTool<S extends ZodRawShape>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

/** A tool answer: pretty JSON, optionally preceded by plain-text notes (expiry, next step). */
export function jsonResult(value: unknown, notes: string[] = []): CallToolResult {
  const content: CallToolResult["content"] = notes.map((text) => ({ type: "text" as const, text }));
  content.push({ type: "text", text: JSON.stringify(value, null, 2) });
  return { content };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
