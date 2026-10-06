// D7 media-out formatting, shared by run_model, check_task, run_workflow and check_workflow_run (through the
// answer envelope in tools/pending.ts). Result links keep their expiry; base64 media is re-hosted through /v2/files
// and never reaches a tool result; MCP image blocks only on request and only for images ≤ 1 MB.
import { Buffer } from "node:buffer";
import type { ImageContent } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext } from "./context.js";
import { credentialHint, errorText } from "./errors.js";

export const EXPIRY_NOTE = "expires 1 h after completion unless store_output was set";

/** Largest image returned as an MCP image content block. */
const INLINE_MAX_BYTES = 1_048_576;
/** Shortest bare string tried as base64 media. */
const MIN_BASE64_CHARS = 200;
const URL_FETCH_TIMEOUT_MS = 15_000;

/**
 * store_output as the formatter sees it: `none` (not asked, or `provider`), `applied` (a relay* SKU the route
 * stores), `unsupported` (a relay* SKU the model cannot store: links stay 1 h, re-hosts take the SKU as retention).
 */
export type Store = "none" | "applied" | "unsupported";

export interface MediaOptions {
  ctx: ToolContext;
  store?: Store;
  /** The relay* SKU asked for (with `applied` / `unsupported`). */
  sku?: string;
  /** Add MCP image content blocks for images ≤ 1 MB. */
  inlineImages?: boolean;
}

/** What the answer envelope consumes: the output with base64 replaced, what was re-hosted, notes, image blocks. */
interface Formatted {
  output: unknown;
  rehosted: { url: string; file_id: string; expires_at: string; retention: string }[];
  notes: string[];
  images: ImageContent[];
}

const ascii = (b: Uint8Array, at: number, s: string) => b.length >= at + s.length && s.split("").every((c, i) => b[at + i] === c.charCodeAt(0));

/**
 * Media type from magic bytes; null otherwise. Never from text. Mirrors the SDK's `sniffMediaType` table (the SDK
 * does not export it), except the MPEG frame sync also checks version and layer: bare base64 is sniffed here, so a
 * looser sync would re-host random strings.
 */
export function sniffMedia(b: Uint8Array): string | null {
  if (b.length < 4) return null;
  if (b[0] === 0x89 && ascii(b, 1, "PNG")) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, "GIF8")) return "image/gif";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WEBP")) return "image/webp";
  if (ascii(b, 0, "RIFF") && ascii(b, 8, "WAVE")) return "audio/wav";
  if (ascii(b, 4, "ftyp")) return ascii(b, 8, "qt  ") ? "video/quicktime" : ascii(b, 8, "M4A ") ? "audio/mp4" : "video/mp4";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "video/webm";
  if (ascii(b, 0, "OggS")) return "audio/ogg";
  if (ascii(b, 0, "fLaC")) return "audio/flac";
  if (ascii(b, 0, "ID3")) return "audio/mpeg";
  // MPEG audio frame sync: 11 set bits, a non-reserved version and layer.
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0 && (b[1] & 0x18) !== 0x08 && (b[1] & 0x06) !== 0) return "audio/mpeg";
  return null;
}

/** The one data: URI grammar (results and upload_file arguments). */
const DATA_URI = /^data:([^;,]+)?(?:;[^;,]*)*;base64,/i;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MEDIA_MIME = /^(image|audio|video)\//i;

const stripWs = (s: string) => (/\s/.test(s) ? s.replace(/\s+/g, "") : s);

/** A base64 argument or data: URI → the bare payload (whitespace dropped) and the URI's declared type, if any. */
export function parseBase64Arg(s: string): { payload: string; type?: string; dataUri: boolean } {
  const m = DATA_URI.exec(s);
  return m ? { payload: stripWs(s.slice(m[0].length)), type: m[1], dataUri: true } : { payload: stripWs(s), dataUri: false };
}

interface Media {
  bytes: Buffer;
  type: string;
  /** The payload as received (reused for an inline image block when it is standard, padded base64). */
  base64: string;
}

function decodePayload(payload: string, declared?: string): Media | null {
  if (!BASE64_BODY.test(payload)) return null;
  const bytes = Buffer.from(payload, "base64");
  const type = sniffMedia(bytes) ?? (declared && MEDIA_MIME.test(declared) ? declared.toLowerCase() : null);
  return type ? { bytes, type, base64: payload } : null;
}

/** A base64 media string → its bytes and type; null for anything else (text, links, short strings). */
export function decodeMedia(s: string): Media | null {
  if (s.startsWith("data:")) {
    const p = parseBase64Arg(s);
    return p.dataUri ? decodePayload(p.payload, p.type) : null;
  }
  if (s.length < MIN_BASE64_CHARS) return null;
  // Peek at the head first: a long non-media string costs one short decode, never a full one.
  const head = stripWs(s.slice(0, 64));
  if (!BASE64_BODY.test(head.replace(/=+$/, "")) || !sniffMedia(Buffer.from(head.slice(0, 32), "base64"))) return null;
  return decodePayload(stripWs(s));
}

const HTTP_URL = /^https?:\/\/\S+$/i;
/** Fields that carry links but never a result (poll and callback addresses, schema pointers). */
const NON_RESULT_KEYS = new Set(["poll_url", "webhook_url", "request_schema_url", "response_schema_url", "status_url", "cancel_url"]);

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Only public-looking https links are fetched for inlining: the hosted server must not become a proxy into its own
 * network for a URL a model echoed back (no plain http, no IP literals, no localhost / *.internal / *.local).
 */
function isFetchableImageUrl(url: string): boolean {
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
async function fetchSmallImage(url: string, signal: AbortSignal): Promise<{ bytes: Buffer; type: string } | "too_large" | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), URL_FETCH_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await globalThis.fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return null;
    const declared = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (declared && !declared.startsWith("image/") && declared !== "application/octet-stream") return null;
    const length = Number(res.headers.get("content-length"));
    if (Number.isFinite(length) && length > INLINE_MAX_BYTES) return "too_large";
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const r = await reader.read();
      if (r.done) break;
      size += r.value.byteLength;
      if (size > INLINE_MAX_BYTES) return "too_large";
      chunks.push(r.value);
    }
    const bytes = Buffer.concat(chunks, size);
    const type = sniffMedia(bytes) ?? (declared.startsWith("image/") ? declared : null);
    return type?.startsWith("image/") ? { bytes, type } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    ctrl.abort(); // drops any unread body
  }
}

function urlExpiry(opts: MediaOptions): string {
  if (opts.store === "applied") return `stored as ${opts.sku} (see get_pricing media_storage for its lifetime)`;
  if (opts.store === "unsupported") return "expires 1 h after completion";
  return EXPIRY_NOTE;
}

/** A standard, padded base64 payload is reused as the image block's data; anything else is re-encoded. */
const blockData = (m: Media) => (m.base64.length % 4 === 0 && !/[-_]/.test(m.base64) ? m.base64 : m.bytes.toString("base64"));

/** A media string found in the output, standing in its (copied) container until its upload settles. */
class Slot {
  constructor(readonly raw: string) {}
}

/** Formats a model output (sync body, task result or run output): URLs with expiry notes, base64 re-hosted, never inlined unless asked. */
export async function formatResult(body: unknown, opts: MediaOptions): Promise<Formatted> {
  const { ctx } = opts;
  const retention = opts.sku ?? "relay1h";
  const urls = new Set<string>();
  const found = new Map<string, Media>(); // one upload per distinct blob, in first-seen order
  const slots: { container: Record<string | number, unknown>; key: string | number; raw: string }[] = [];

  // Synchronous walk, copy-on-write: a body without media comes back as the same object.
  const walk = (v: unknown, key: string | null): unknown => {
    if (typeof v === "string") {
      if (v.startsWith("data:") || v.length >= MIN_BASE64_CHARS) {
        const media = found.has(v) ? found.get(v)! : decodeMedia(v);
        if (media) {
          found.set(v, media);
          return new Slot(v);
        }
      }
      if (HTTP_URL.test(v) && !(key && NON_RESULT_KEYS.has(key))) urls.add(v);
      return v;
    }
    let out: Record<string | number, unknown> | unknown[] | null = null;
    const visit = (x: unknown, k: string | number, childKey: string | null, copy: () => Record<string | number, unknown> | unknown[]) => {
      const y = walk(x, childKey);
      if (y === x) return;
      out ??= copy();
      const container = out as Record<string | number, unknown>;
      container[k] = y;
      if (y instanceof Slot) slots.push({ container, key: k, raw: y.raw });
    };
    if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, i, key, () => v.slice()));
      return out ?? v;
    }
    if (isPlainObject(v)) {
      for (const k of Object.keys(v)) visit(v[k], k, k, () => ({ ...v }));
      return out ?? v;
    }
    return v;
  };

  const holder = walk({ output: body }, null) as { output: unknown };

  const notes: string[] = [];
  const rehosted: Formatted["rehosted"] = [];
  const images: ImageContent[] = [];
  const tooLarge: string[] = []; // image links over the inline cap
  const replacement = new Map<string, string>();

  if (found.size) {
    if (!ctx.hasCredential) {
      for (const [raw, m] of found) replacement.set(raw, `<base64 omitted: ${m.bytes.byteLength} bytes>`);
      notes.push(`${found.size} base64 media result(s) omitted: re-hosting through /v2/files needs a Relay credential. ${credentialHint(ctx.transport)}`);
    } else {
      const client = ctx.client();
      const entries = [...found];
      const settled = await Promise.allSettled(
        entries.map(([, m]) => client.files.upload(m.bytes, { contentType: m.type, retention, signal: ctx.signal })),
      );
      const failures: string[] = [];
      settled.forEach((s, i) => {
        const [raw, m] = entries[i];
        if (s.status === "rejected") {
          replacement.set(raw, `<base64 omitted: ${m.bytes.byteLength} bytes; re-host failed>`);
          failures.push(`Re-hosting a ${m.bytes.byteLength}-byte ${m.type} result failed:\n${errorText(s.reason, ctx.transport)}`);
          return;
        }
        const file = s.value;
        const r = { url: file.url, file_id: file.file_id, expires_at: file.expires_at, retention: file.retention ?? retention };
        rehosted.push(r);
        notes.push(`${r.url}: re-hosted through /v2/files (${r.retention}), expires at ${r.expires_at}.`);
        replacement.set(raw, file.url);
        if (opts.inlineImages && m.type.startsWith("image/")) {
          if (m.bytes.byteLength <= INLINE_MAX_BYTES) images.push({ type: "image", data: blockData(m), mimeType: m.type });
          else tooLarge.push(file.url);
        }
      });
      notes.push(...failures);
    }
    for (const s of slots) s.container[s.key] = replacement.get(s.raw);
  }

  if (urls.size) {
    const expiry = urlExpiry(opts);
    notes.push(["Result links:", ...[...urls].map((u) => `- ${u}: ${expiry}`)].join("\n"));
    if (opts.store === "unsupported" && found.size === 0) {
      notes.push("store_output is not supported by this model; the link expires 1 h after completion.");
    }
  }

  if (opts.inlineImages) {
    const fetched = await Promise.all([...urls].filter(isFetchableImageUrl).map(async (u) => [u, await fetchSmallImage(u, ctx.signal)] as const));
    for (const [u, got] of fetched) {
      if (got === "too_large") tooLarge.push(u);
      else if (got) images.push({ type: "image", data: got.bytes.toString("base64"), mimeType: got.type });
    }
    for (const u of tooLarge) notes.push(`${u}: image > 1 MB not inlined.`);
  }

  return { output: holder.output, rehosted, notes, images };
}
