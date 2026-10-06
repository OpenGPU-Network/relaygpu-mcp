// D7 media-out formatting, shared by run_model, check_task, run_workflow and check_workflow_run.
// Result links keep their expiry; base64 media is re-hosted through /v2/files and never reaches a tool result;
// MCP image blocks only on request and only for images ≤ 1 MB.
import { Buffer } from "node:buffer";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Relay } from "@relaygpu/client";
import type { ToolContext } from "./context.js";
import { jsonResult } from "./context.js";
import { credentialHint, errorText } from "./errors.js";

export const EXPIRY_NOTE = "expires 1 h after completion unless store_output was set";

/** Largest image returned as an MCP image content block. */
export const INLINE_MAX_BYTES = 1_048_576;
/** Shortest bare string tried as base64 media. */
const MIN_BASE64_CHARS = 200;
const URL_FETCH_TIMEOUT_MS = 15_000;

const SKU_LIFETIMES: Record<string, string> = { relay1d: "1 day", relay7d: "7 days", relay30d: "30 days" };

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

/** One base64 blob re-hosted through `/v2/files`. */
export interface Rehosted {
  url: string;
  file_id: string;
  expires_at: string;
  retention: string;
}

const ascii = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/** Media type from magic bytes (png, jpeg, webp, gif, wav, mp3, mp4, ogg, flac); null otherwise. Never from text. */
export function sniffMedia(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && ascii(b, 1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, "GIF8")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav";
  if (ascii(b, 4, "ftyp")) return ascii(b, 8, "M4A ") ? "audio/mp4" : "video/mp4";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (ascii(b, 0, "fLaC")) return "audio/flac";
  if (ascii(b, 0, "ID3")) return "audio/mpeg";
  // MPEG audio frame sync: 11 set bits, a non-reserved version and layer.
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0) return "audio/mpeg";
  return null;
}

const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+)?((?:;[a-z0-9-]+=[^;,]*)*);base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MEDIA_MIME = /^(image|audio|video)\//i;

/** A base64 media string → its bytes and type; null for anything else (text, links, short strings). */
export function decodeMedia(s: string): { bytes: Uint8Array; type: string } | null {
  const m = DATA_URI.exec(s);
  if (m) {
    const payload = s.slice(m[0].length).replace(/\s+/g, "");
    if (!BASE64_BODY.test(payload)) return null;
    const bytes = new Uint8Array(Buffer.from(payload, "base64"));
    const type = sniffMedia(bytes) ?? (m[1] && MEDIA_MIME.test(m[1]) ? m[1].toLowerCase() : null);
    return type ? { bytes, type } : null;
  }
  if (s.length < MIN_BASE64_CHARS) return null;
  // Peek at the head first: a long non-media string costs one short decode, never a full one.
  const head = s.slice(0, 64).replace(/\s+/g, "");
  if (!BASE64_BODY.test(head.replace(/=+$/, "")) || !sniffMedia(new Uint8Array(Buffer.from(head.slice(0, 32), "base64")))) return null;
  const payload = s.replace(/\s+/g, "");
  if (!BASE64_BODY.test(payload)) return null;
  const bytes = new Uint8Array(Buffer.from(payload, "base64"));
  const type = sniffMedia(bytes);
  return type ? { bytes, type } : null;
}

const HTTP_URL = /^https?:\/\/\S+$/i;
/** Fields that carry links but never a result (poll and callback addresses, schema pointers). */
const NON_RESULT_KEYS = new Set(["poll_url", "webhook_url", "request_schema_url", "response_schema_url", "status_url", "cancel_url"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `store_output` → the upload retention for re-hosted bytes: none/`provider` → `relay1h`, any `relay*` SKU as is. */
export function retentionFor(storeOutput: string | undefined): string {
  return !storeOutput || storeOutput === "provider" ? "relay1h" : storeOutput;
}

interface ImageBlock {
  type: "image";
  data: string;
  mimeType: string;
}

/**
 * Only public-looking https links are fetched for inlining: the hosted server must not become a proxy into its own
 * network for a URL a model echoed back (no plain http, no IP literals, no localhost / *.internal / *.local).
 */
export function isFetchableImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || u.username || u.password) return false;
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) return false;
  if (/^[\d.]+$/.test(host) || host.startsWith("[")) return false;
  return true;
}

/** Fetches a result link for inlining; null when it is not an image or is (or turns out) larger than 1 MB. */
async function fetchSmallImage(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; type: string } | "too_large" | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await globalThis.fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (declared && !declared.startsWith("image/") && declared !== "application/octet-stream") {
      ctrl.abort();
      return null;
    }
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > INLINE_MAX_BYTES) {
      ctrl.abort();
      return "too_large";
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > INLINE_MAX_BYTES) {
        ctrl.abort();
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(r.value);
    }
    const bytes = new Uint8Array(Buffer.concat(chunks));
    const type = sniffMedia(bytes) ?? (declared.startsWith("image/") ? declared : null);
    return type?.startsWith("image/") ? { bytes, type } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

function urlExpiry(opts: MediaOptions): string {
  const sku = opts.storeOutput;
  if (opts.storeOutputApplied && sku && sku !== "provider") {
    return `stored as ${sku}: ${SKU_LIFETIMES[sku] ? `kept for ${SKU_LIFETIMES[sku]}` : `kept per ${sku}`}`;
  }
  if (sku && sku !== "provider" && !opts.storeOutputApplied) return "expires 1 h after completion";
  return EXPIRY_NOTE;
}

/** Formats a model output (sync body, task result or run output): URLs with expiry notes, base64 re-hosted, never inlined unless asked. */
export async function formatResult(body: unknown, opts: MediaOptions): Promise<CallToolResult> {
  const { ctx } = opts;
  const retention = retentionFor(opts.storeOutput);
  const urls: string[] = [];
  const rehosted: Rehosted[] = [];
  const omitted: string[] = [];
  const failures: string[] = [];
  const images: { bytes: Uint8Array; type: string }[] = [];
  const tooLarge: string[] = []; // image links over the inline cap
  const byString = new Map<string, string>(); // one upload per distinct blob
  let client: Relay | null | undefined;
  let missingCredential = false;

  const rehost = async (raw: string, media: { bytes: Uint8Array; type: string }): Promise<string> => {
    const seen = byString.get(raw);
    if (seen !== undefined) return seen;
    let out: string;
    if (client === undefined) {
      try {
        client = ctx.client();
      } catch {
        client = null;
      }
    }
    if (!client) {
      missingCredential = true;
      out = `<base64 omitted: ${media.bytes.byteLength} bytes>`;
      omitted.push(out);
    } else {
      try {
        const file = await client.files.upload(new Blob([media.bytes as Uint8Array<ArrayBuffer>], { type: media.type }), { retention, signal: ctx.signal });
        rehosted.push({ url: file.url, file_id: file.file_id, expires_at: file.expires_at, retention: file.retention ?? retention });
        if (opts.inlineImages && media.type.startsWith("image/")) {
          if (media.bytes.byteLength <= INLINE_MAX_BYTES) images.push(media);
          else tooLarge.push(file.url);
        }
        out = file.url;
      } catch (e) {
        out = `<base64 omitted: ${media.bytes.byteLength} bytes; re-host failed>`;
        failures.push(`Re-hosting a ${media.bytes.byteLength}-byte ${media.type} result failed:\n${errorText(e, ctx.transport)}`);
      }
    }
    byString.set(raw, out);
    return out;
  };

  const walk = async (v: unknown, key: string | null): Promise<unknown> => {
    if (typeof v === "string") {
      const media = decodeMedia(v);
      if (media) return rehost(v, media);
      if (HTTP_URL.test(v) && !(key && NON_RESULT_KEYS.has(key)) && !urls.includes(v)) urls.push(v);
      return v;
    }
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const x of v) out.push(await walk(x, key));
      return out;
    }
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) out[k] = await walk(x, k);
      return out;
    }
    return v;
  };

  const formatted = await walk(body, null);

  const notes = [...(opts.notes ?? [])];
  for (const r of rehosted) notes.push(`${r.url}: re-hosted through /v2/files (${r.retention}), expires at ${r.expires_at}.`);
  if (missingCredential) {
    notes.push(
      `${omitted.length} base64 media result(s) omitted: re-hosting through /v2/files needs a Relay credential. ${credentialHint(ctx.transport)}`,
    );
  }
  notes.push(...failures);
  if (urls.length) {
    const expiry = urlExpiry(opts);
    notes.push(["Result links:", ...urls.map((u) => `- ${u}: ${expiry}`)].join("\n"));
    const storeAsked = opts.storeOutput && opts.storeOutput !== "provider";
    if (storeAsked && !opts.storeOutputApplied && rehosted.length === 0 && omitted.length === 0) {
      notes.push("store_output is not supported by this model; the link expires 1 h after completion.");
    }
  }

  if (opts.inlineImages) {
    for (const u of urls) {
      if (!isFetchableImageUrl(u)) continue;
      const got = await fetchSmallImage(u, ctx.signal);
      if (got === "too_large") tooLarge.push(u);
      else if (got) images.push(got);
    }
    for (const u of tooLarge) notes.push(`${u}: image > 1 MB not inlined.`);
  }

  const answer = rehosted.length ? (isPlainObject(formatted) ? { ...formatted, rehosted } : { result: formatted, rehosted }) : formatted;
  const result = jsonResult(answer, notes);
  for (const img of images) {
    const block: ImageBlock = { type: "image", data: Buffer.from(img.bytes).toString("base64"), mimeType: img.type };
    result.content.push(block);
  }
  return result;
}
