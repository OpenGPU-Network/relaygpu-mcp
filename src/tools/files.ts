// upload_file: a local path (stdio only, streamed), base64 (≤ 4 MB) or a public URL → a Relay-hosted link.
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import { basename, extname } from "node:path";
import { Readable } from "node:stream";
import { z } from "zod";
import type { FileData } from "@relaygpu/client";
import { defineTool, jsonResult, textResult, type ToolDef } from "../context.js";

/** The server's per-file ceiling (`POST /v2/files`). */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
/** Largest base64 payload accepted in a tool argument (decoded bytes). */
export const MAX_BASE64_BYTES = 4 * 1024 * 1024;

export const HOSTED_PATH_REFUSAL =
  "upload_file(path) works only on the local (stdio) server: this hosted server cannot read your disk. Pass base64 (≤ 4 MB) or url instead.";

const EXT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

const errorResult = (text: string) => ({ ...textResult(text), isError: true });

type OpenAsBlob = (path: string, opts?: { type?: string }) => Promise<Blob>;

/** A file as an upload body without reading it into memory: `fs.openAsBlob` (Node ≥ 19.8), else a stream. */
async function fileBody(path: string, type: string | undefined): Promise<FileData> {
  const openAsBlob = (fs as unknown as { openAsBlob?: OpenAsBlob }).openAsBlob;
  if (openAsBlob) return openAsBlob(path, type ? { type } : undefined);
  return Readable.toWeb(fs.createReadStream(path)) as unknown as ReadableStream<Uint8Array>;
}

const DATA_URI = /^data:([^;,]+)?(?:;[^;,]*)*;base64,/i;

const upload_file = defineTool({
  name: "upload_file",
  title: "Upload a file to Relay",
  description:
    "Hosts an image, video or audio file on Relay and returns its url: pass that url to any *_url input of run_model. " +
    "Give exactly one of path (local server only, ≤ 100 MB), base64 (≤ 4 MB) or url (a public link Relay copies). " +
    "retention: relay1h (default, free within a daily quota) or a media_storage SKU from get_pricing.",
  inputSchema: {
    path: z.string().optional().describe("Local file path (stdio server only; the hosted server cannot read your disk). Max 100 MB."),
    base64: z.string().optional().describe("File content as base64 or a data: URI, at most 4 MB decoded. Larger files: pass url."),
    url: z.string().optional().describe("Public http(s) link to copy onto Relay."),
    retention: z
      .string()
      .optional()
      .describe("How long the link lives: relay1h (default, free within a daily quota) or a media_storage SKU from get_pricing (relay1d, relay7d, …)."),
    filename: z.string().optional().describe("File name to record (defaults to the path's base name)."),
  },
  annotations: { title: "Upload a file to Relay", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  async handler(args, ctx) {
    const { path, base64, url, retention, filename } = args;
    const given = [path, base64, url].filter((v) => v != null && v !== "").length;
    if (given !== 1) return errorResult("upload_file takes exactly one of path, base64 or url.");
    if (path && ctx.transport === "http") return errorResult(HOSTED_PATH_REFUSAL);

    let decoded: { bytes: Buffer; type?: string } | undefined;
    if (base64) {
      const m = DATA_URI.exec(base64);
      const payload = (m ? base64.slice(m[0].length) : base64).replace(/\s+/g, "");
      // Refuse on the encoded length first, so an oversized argument is never decoded.
      if (Math.floor((payload.length * 3) / 4) - (payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0) > MAX_BASE64_BYTES) {
        return errorResult("base64 is over 4 MB decoded: host the file somewhere public and pass url instead (or path on the local server).");
      }
      decoded = { bytes: Buffer.from(payload, "base64"), type: m?.[1] };
      if (decoded.bytes.byteLength === 0) return errorResult("base64 decodes to no bytes.");
    }

    let local: { body: FileData; name: string; type?: string } | undefined;
    if (path) {
      let st: fs.Stats;
      try {
        st = await fs.promises.stat(path);
      } catch {
        return errorResult(`No file at ${path}.`);
      }
      if (!st.isFile()) return errorResult(`${path} is not a regular file.`);
      if (st.size > MAX_UPLOAD_BYTES) {
        return errorResult(`File is ${st.size} bytes: over the 100 MB upload limit (code: FILE_TOO_LARGE). Nothing was uploaded.`);
      }
      const type = EXT_TYPES[extname(path).toLowerCase()];
      local = { body: await fileBody(path, type), name: basename(path), type };
    }

    const client = ctx.client();
    const file = local
      ? await client.files.upload(local.body, { retention, filename: filename ?? local.name, contentType: local.type, signal: ctx.signal })
      : decoded
        ? await client.files.upload(new Blob([new Uint8Array(decoded.bytes)], decoded.type ? { type: decoded.type } : undefined), {
            retention,
            filename,
            signal: ctx.signal,
          })
        : await client.files.copy(url!, { retention, filename, signal: ctx.signal });

    return jsonResult(file, [`This link expires at ${file.expires_at}; pass it to any *_url input of run_model.`]);
  },
});

export const filesTools: ToolDef[] = [upload_file];
