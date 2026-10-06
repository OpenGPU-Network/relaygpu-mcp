// Catalog tools (keyless): search_models, get_model, get_pricing, estimate_cost. Read through ctx.catalog only.
import { z } from "zod";
import type { UsageInput } from "@relaygpu/client";
import { defineTool, jsonResult, type ToolDef } from "../context.js";

const SEARCH_CAP = 50;
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

/** The part of a pricing row's `model` after its `source.` prefix (`image.Qwen/qwen-image` → `Qwen/qwen-image`). */
const rowModel = (m: string) => m.slice(m.indexOf(".") + 1);

const search_models = defineTool({
  name: "search_models",
  title: "Search Relay models",
  description:
    "Lists Relay models by tag and/or text. Common tags: text-to-image, image-to-image, text-to-video, image-to-video, " +
    "video-to-video, text-to-speech, speech-to-text, text-to-text, text-to-embedding. Returns name, tag and route per " +
    "model (at most 50). Then call get_model with a name for its input schema.",
  inputSchema: {
    tag: z.string().optional().describe("Model type tag, e.g. text-to-image or image-to-video. Omit for every tag."),
    query: z
      .string()
      .optional()
      .describe("Words to match, case-insensitive; every word must appear in the name, display name or tag (e.g. 'kling v3')."),
  },
  annotations: { title: "Search Relay models", ...READ_ONLY },
  async handler({ tag, query }, ctx) {
    const rows = await ctx.catalog.models.list({ tag: tag || undefined, signal: ctx.signal });
    const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const matches = rows.filter((r) => {
      const hay = `${r.name} ${r.display_name ?? ""} ${r.tag}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const models = matches.slice(0, SEARCH_CAP).map((r) => ({
      name: r.name,
      display_name: r.display_name ?? null,
      tag: r.tag,
      endpoint: r.endpoint?.path ?? null,
      async_default: r.endpoint?.async_default ?? null,
      store_output_supported: r.store_output_supported,
    }));
    const notes: string[] = [];
    if (matches.length > SEARCH_CAP) {
      notes.push(`Showing ${SEARCH_CAP} of ${matches.length} models: narrow with tag/query.`);
    } else if (matches.length === 0) {
      notes.push("No model matched: try fewer query words or another tag.");
    }
    notes.push("Next: get_model(model) for its request schema and example.");
    return jsonResult({ total: matches.length, models }, notes);
  },
});

const get_model = defineTool({
  name: "get_model",
  title: "Get a Relay model",
  description:
    "Returns one model's route, request_schema (what run_model's input must follow), request_example, pricing and " +
    "availability. Then call run_model with an input shaped like request_example.",
  inputSchema: {
    model: z.string().describe("Exact model name from search_models, e.g. Qwen/qwen-image."),
  },
  annotations: { title: "Get a Relay model", ...READ_ONLY },
  async handler({ model }, ctx) {
    const d = await ctx.catalog.models.get(model);
    const notes =
      d.status === "retired"
        ? ["This model is retired: run_model refuses it. Use search_models to pick another."]
        : ["Next: run_model(model, input) with input following request_schema (request_example runs as is)."];
    return jsonResult(
      {
        name: d.name,
        display_name: d.display_name ?? null,
        tag: d.tag ?? null,
        status: d.status,
        available: d.available,
        endpoint: d.endpoint,
        store_output_supported: d.store_output_supported,
        restricted_tiers: d.restricted_tiers,
        pricing: d.pricing,
        request_schema: d.request_schema,
        request_example: d.request_example,
        response_schema_url: d.response_schema_url,
      },
      notes,
    );
  },
});

const get_pricing = defineTool({
  name: "get_pricing",
  title: "Get Relay pricing",
  description:
    "Returns Relay's public list prices (USD), optionally for one model, plus media_storage: the per-file fees of the " +
    "store_output / upload retention SKUs (relay1d, relay7d, …). Then estimate_cost for a number.",
  inputSchema: {
    model: z.string().optional().describe("Model name (e.g. Qwen/qwen-image) to keep only its rows. Omit for every model."),
  },
  annotations: { title: "Get Relay pricing", ...READ_ONLY },
  async handler({ model }, ctx) {
    const p = await ctx.catalog.pricing.get({ signal: ctx.signal });
    const rows = model ? p.pricing.filter((r) => rowModel(r.model) === model || r.model === model) : p.pricing;
    const notes: string[] = [];
    if (model && rows.length === 0) notes.push(`No pricing row for '${model}': check the name with search_models.`);
    notes.push(
      p.media_storage
        ? "media_storage keys are the store_output values run_model accepts and the retention values upload_file accepts (relay1h uploads are free); 'provider' (default) keeps the provider's 1 h link."
        : "This environment offers no paid storage: store_output stays 'provider' (links expire after 1 h).",
    );
    return jsonResult({ pricing: rows, total_count: rows.length, media_storage: p.media_storage ?? null }, notes);
  },
});

const usageSchema = z
  .object({
    mode: z.enum(["direct", "opengpu"]).optional().describe("Pricing mode; default direct."),
    input_tokens: z.number().optional().describe("per_token: prompt tokens."),
    output_tokens: z.number().optional().describe("per_token: completion tokens."),
    cached_input_tokens: z.number().optional().describe("per_token: cached-read tokens (a subset of input_tokens)."),
    cache_write_5m_input_tokens: z.number().optional().describe("per_token: 5-minute prompt-cache writes (a subset of input_tokens)."),
    cache_write_1h_input_tokens: z.number().optional().describe("per_token: 1-hour prompt-cache writes (a subset of input_tokens)."),
    image_count: z.number().optional().describe("per_image: images generated (default 1)."),
    resolution_tier: z.string().optional().describe("per_image / per_second_video: resolution key of the row, e.g. 1K, 2K, 720p."),
    duration_seconds: z.number().optional().describe("per_second_video / per_second_audio: seconds of output (or input audio)."),
    quality_mode: z.string().optional().describe("per_second_video: std or pro (Kling)."),
    sound: z.boolean().optional().describe("per_second_video: sound on or off."),
    has_ref: z.boolean().optional().describe("per_second_video: a reference input is present (Kling O1)."),
    character_count: z.number().optional().describe("per_character: characters of text to speak."),
    media_input_tokens: z.number().optional().describe("per_media_token: media input tokens."),
    media_output_tokens: z.number().optional().describe("per_media_token: media output tokens."),
    request_count: z.number().optional().describe("per_request: requests (default 1)."),
    store_output: z.string().optional().describe("Output storage SKU from get_pricing media_storage (adds its per-file fee); provider is free."),
    retention: z.string().optional().describe("Upload retention SKU from get_pricing media_storage; relay1h is free."),
    file_count: z.number().optional().describe("Files the storage fee applies to (default image_count, else 1)."),
  })
  .passthrough();

const estimate_cost = defineTool({
  name: "estimate_cost",
  title: "Estimate a Relay cost",
  description:
    "Estimates the USD cost of a call from the public price list: an estimate, not an invoice (the bill uses " +
    "provider-reported usage and any custom pricing on your account). Pass only the usage fields the model's " +
    "billing_type (see get_model or get_pricing) reads: per_token: input_tokens, output_tokens, cached_input_tokens; " +
    "per_image: image_count, resolution_tier; per_second_video: duration_seconds, quality_mode, sound; " +
    "per_second_audio: duration_seconds; per_character: character_count; per_media_token: media_input_tokens, " +
    "media_output_tokens. Add store_output / retention / file_count for storage fees.",
  inputSchema: {
    model: z.string().describe("Exact model name, e.g. KlingTeam/v3-T2V."),
    usage: usageSchema.describe("What the call uses; only the fields of the model's billing type matter."),
  },
  annotations: { title: "Estimate a Relay cost", ...READ_ONLY },
  async handler({ model, usage }, ctx) {
    const est = await ctx.catalog.estimateCost(model, usage as UsageInput);
    return jsonResult({ model, usd: est.usd, basis: est.basis }, ["Estimate only, not an invoice. Next: run_model to run it."]);
  },
});

export const catalogTools: ToolDef[] = [search_models, get_model, get_pricing, estimate_cost];
