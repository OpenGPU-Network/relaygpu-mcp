// Fixtures for package (a) unit tests, built programmatically (no binary files in the repo).
import { Buffer } from "node:buffer";

/** `size` bytes starting with the PNG signature (the rest is a deterministic pattern). */
export function pngBytes(size: number): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < size; i++) b[i] = (i * 31) & 0xff;
  return b;
}

/** A small WAV-headed buffer. */
export function wavBytes(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set(Buffer.from("RIFF"), 0);
  b.set(Buffer.from("WAVE"), 8);
  for (let i = 12; i < size; i++) b[i] = i & 0xff;
  return b;
}

export const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");

export const QWEN = "Qwen/qwen-image";
export const KLING = "KlingTeam/v3-T2V";
export const GPT_IMAGE = "openai/gpt-image-2";

export function modelDetail(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const endpoint = (over.endpoint as Record<string, unknown> | undefined) ?? {};
  return {
    name,
    display_name: name.split("/")[1],
    tag: "text-to-image",
    modes: ["auto", "direct"],
    sources: ["image"],
    request_schema: { type: "object", properties: { prompt: { type: "string" } } },
    request_schema_url: "#/components/schemas/X",
    request_example: { prompt: "a cat" },
    response_schema: { type: "object" },
    response_schema_url: "#/components/schemas/Y",
    store_output_supported: true,
    restricted_tiers: ["guest"],
    pricing: [{ mode: "direct", model: `image.${name}`, billing_type: "per_image", per_image: 0.036 }],
    available: true,
    status: "available",
    ...over,
    endpoint: {
      method: "POST",
      path: "/v2/image/qwen/generate",
      operation_id: "image_qwen_generate",
      model_in_body: true,
      model_default: null,
      async_default: false,
      streams: false,
      ...endpoint,
    },
  };
}

export const PRICING = {
  pricing: [
    { mode: "direct", model: `image.${QWEN}`, billing_type: "per_image", per_image: 0.036 },
    { mode: "direct", model: `video.${KLING}`, billing_type: "per_second_video", per_second_video: { "std|silent": 0.084, "pro|silent": 0.112 } },
    { mode: "direct", model: "openai.openai/gpt-5.4", billing_type: "per_token", per_1m_input_tokens: 2, per_1m_output_tokens: 8 },
  ],
  total_count: 3,
  media_storage: { relay1d: 0.0005, relay7d: 0.001, relay30d: 0.003, unit: "per_file" },
};

export const fileResponse = (over: Record<string, unknown> = {}) => ({
  file_id: "file_abc123",
  url: "https://cdn.relaygpu.test/f/abc123.png",
  expires_at: "2026-10-06T13:00:00Z",
  created_at: "2026-10-06T12:00:00Z",
  retention: "relay1h",
  cost_usd: 0,
  seconds_left: 3600,
  source: "upload",
  status: "ready",
  content_type: "image/png",
  size_bytes: 1234,
  ...over,
});

export const modelPath = (name: string) => `/v2/models/${name}`;

type Block = { type: string; text?: string; data?: string; mimeType?: string };
/** The JSON block of a tool answer (jsonResult puts it after the notes). */
export function jsonOf(r: { content: unknown }): any {
  const texts = (r.content as Block[]).filter((b) => b.type === "text");
  return JSON.parse(texts[texts.length - 1].text!);
}
/** The note lines (every text block but the JSON). */
export function notesOf(r: { content: unknown }): string {
  const texts = (r.content as Block[]).filter((b) => b.type === "text");
  return texts.slice(0, -1).map((b) => b.text).join("\n");
}
export const imagesOf = (r: { content: unknown }) => (r.content as Block[]).filter((b) => b.type === "image");
