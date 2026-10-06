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
  /** True when the connection carries a credential (`client()` will not throw). */
  hasCredential: boolean;
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
  /** Also the annotations title (the server adds it). */
  title: string;
  description: string;
  /** zod raw shape; every field carries `.describe()`. */
  inputSchema: S;
  annotations?: Omit<ToolAnnotations, "title">;
  /** Needs a credential: the server refuses it without one before the handler runs (zero requests). */
  billed?: boolean;
  handler(args: z.objectOutputType<S, z.ZodTypeAny>, ctx: ToolContext): Promise<CallToolResult>;
}

/** Identity helper that keeps the handler's argument type tied to its schema. */
export function defineTool<S extends ZodRawShape>(tool: ToolDef<S>): ToolDef {
  return tool as unknown as ToolDef;
}

const PRETTY_MAX = 4 * 1024;

/** A tool answer: JSON (pretty under 4 KB, compact above), optionally preceded by plain-text notes (expiry, next step). */
export function jsonResult(value: unknown, notes: string[] = []): CallToolResult {
  const content: CallToolResult["content"] = notes.map((text) => ({ type: "text" as const, text }));
  const compact = JSON.stringify(value) ?? "null";
  content.push({ type: "text", text: compact.length < PRETTY_MAX ? JSON.stringify(value, null, 2) : compact });
  return { content };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/** A plain tool error (a local refusal; SDK errors go through the mapper in errors.ts). */
export function errorResult(text: string): CallToolResult {
  return { ...textResult(text), isError: true };
}
