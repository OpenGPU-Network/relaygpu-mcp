// upload_file: a local path (stdio only, streamed), base64 (≤ 4 MB) or a public URL → a Relay-hosted link.
// The media type comes from a data: URI's declared type, else the SDK sniffs the first bytes.
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import { FileTooLargeError, type FileData, type FileObject } from "@relaygpu/client";
import { defineTool, errorResult, jsonResult, type ToolDef } from "../context.js";
import { parseBase64Arg } from "../media.js";

const MB = 1024 * 1024;
/** The server's per-file ceiling (`POST /v2/files`). */
const MAX_UPLOAD_BYTES = 100 * MB;
/** Largest base64 payload accepted in a tool argument (decoded bytes). */
export const MAX_BASE64_BYTES = 4 * MB;
const mb = (n: number) => `${n / MB} MB`;

export const HOSTED_PATH_REFUSAL =
  `upload_file(path) works only on the local (stdio) server: this hosted server cannot read your disk. Pass base64 (≤ ${mb(MAX_BASE64_BYTES)}) or url instead.`;

type OpenAsBlob = (path: string) => Promise<Blob>;

/** A file as an upload body without reading it into memory: `fs.openAsBlob` (Node ≥ 19.8), else a stream (Node 18). */
async function fileBody(path: string): Promise<FileData> {
  const openAsBlob = (fs as unknown as { openAsBlob?: OpenAsBlob }).openAsBlob;
  if (openAsBlob) return openAsBlob(path);
  return Readable.toWeb(fs.createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

/** Decoded size of a base64 payload, from its length (never decodes). */
const decodedSize = (payload: string) => Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0);

const done = (file: FileObject) => jsonResult(file, [`This link expires at ${file.expires_at}; pass it to any *_url input of run_model.`]);

const upload_file = defineTool({
  name: "upload_file",
  title: "Upload a file to Relay",
  description:
    "Hosts an image, video or audio file on Relay and returns its url: pass that url to any *_url input of run_model. " +
    `Give exactly one of path (local server only, ≤ ${mb(MAX_UPLOAD_BYTES)}), base64 (≤ ${mb(MAX_BASE64_BYTES)}) or url (a public link Relay copies). ` +
    "retention: relay1h (default, free within a daily quota) or a media_storage SKU from get_pricing.",
  inputSchema: {
    path: z.string().optional().describe(`Local file path (stdio server only; the hosted server cannot read your disk). Max ${mb(MAX_UPLOAD_BYTES)}.`),
    base64: z.string().optional().describe(`File content as base64 or a data: URI, at most ${mb(MAX_BASE64_BYTES)} decoded. Larger files: pass url.`),
    url: z.string().optional().describe("Public http(s) link to copy onto Relay."),
    retention: z
      .string()
      .optional()
      .describe("How long the link lives: relay1h (default, free within a daily quota) or a media_storage SKU from get_pricing (relay1d, relay7d, …)."),
    filename: z.string().optional().describe("File name to record (defaults to the path's base name)."),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  billed: true,
  async handler({ path, base64, url, retention, filename }, ctx) {
    if ([path, base64, url].filter((v) => v != null && v !== "").length !== 1) return errorResult("upload_file takes exactly one of path, base64 or url.");
    const opts = { retention, filename, signal: ctx.signal };

    if (url) return done(await ctx.client().files.copy(url, opts));

    if (base64) {
      const { payload, type } = parseBase64Arg(base64);
      // Refuse on the encoded length first, so an oversized argument is never decoded.
      if (decodedSize(payload) > MAX_BASE64_BYTES) {
        return errorResult(`base64 is over ${mb(MAX_BASE64_BYTES)} decoded: host the file somewhere public and pass url instead (or path on the local server).`);
      }
      const bytes = Buffer.from(payload, "base64");
      if (bytes.byteLength === 0) return errorResult("base64 decodes to no bytes.");
      return done(await ctx.client().files.upload(bytes, { ...opts, contentType: type }));
    }

    if (ctx.transport === "http") return errorResult(HOSTED_PATH_REFUSAL);
    const st = await fs.promises.stat(path!).catch(() => null);
    if (!st) return errorResult(`No file at ${path}.`);
    if (!st.isFile()) return errorResult(`${path} is not a regular file.`);
    if (st.size > MAX_UPLOAD_BYTES) {
      throw new FileTooLargeError({
        message: `File is ${st.size} bytes: over the ${mb(MAX_UPLOAD_BYTES)} upload limit. Nothing was uploaded.`,
        status: 413,
        code: "FILE_TOO_LARGE",
      });
    }
    return done(await ctx.client().files.upload(await fileBody(path!), { ...opts, filename: filename ?? basename(path!) }));
  },
});

export const filesTools: ToolDef[] = [upload_file];
