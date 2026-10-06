// search_docs: BM25 over the bundled public-docs index (src/generated/docs-index.json, built by
// `npm run build:docs`). Keyless, no network.
import { z } from "zod";
import { defineTool, jsonResult, textResult, type ToolDef } from "../context.js";
import docsIndex from "../generated/docs-index.json";

export interface DocSection {
  page: string;
  title: string;
  heading: string;
  anchor: string;
  text: string;
}

export interface DocHit {
  page: string;
  title: string;
  heading: string;
  /** Docs-relative path + anchor, e.g. `reference/async-webhooks.md#safe-retries-idempotency-key`. */
  path: string;
  score: number;
  excerpt: string;
}

export const EXCERPT_MAX = 1_200;
const K1 = 1.2;
const B = 0.75;
const HEADING_WEIGHT = 3;

const STOPWORDS = new Set(
  "a an and are as at be by can do does for from how i in is it its of on or that the this to what when with you your".split(" "),
);

/** Naive stemmer: retries → retry, keys → key, streaming → stream. Applied identically to docs and queries. */
function stem(t: string): string {
  if (t.length > 5 && t.endsWith("ing")) return t.slice(0, -3);
  if (t.length > 4 && t.endsWith("ies")) return t.slice(0, -3) + "y";
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) return t.slice(0, -1);
  return t;
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

interface Indexed {
  section: DocSection;
  tf: Map<string, number>;
  len: number;
}

interface Bm25 {
  docs: Indexed[];
  df: Map<string, number>;
  avgLen: number;
}

let built: Bm25 | undefined;

function build(sections: DocSection[]): Bm25 {
  const df = new Map<string, number>();
  const docs = sections.map((section) => {
    const tf = new Map<string, number>();
    const add = (tokens: string[], w: number) => tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + w));
    add(tokenize(section.text), 1);
    add(tokenize(section.heading), HEADING_WEIGHT);
    add(tokenize(section.title), 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    let len = 0;
    for (const n of tf.values()) len += n;
    return { section, tf, len };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / Math.max(1, docs.length);
  return { docs, df, avgLen };
}

/** Trims to ≤ max characters on a word boundary (an ellipsis marks the cut). */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.search(/\s\S*$/);
  return (at > max / 2 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

export function searchDocs(query: string, limit = 5, sections: DocSection[] = docsIndex.sections): DocHit[] {
  const idx = sections === docsIndex.sections ? (built ??= build(sections)) : build(sections);
  const terms = [...new Set(tokenize(query))];
  const N = idx.docs.length;
  const scored: { d: Indexed; score: number }[] = [];
  for (const d of idx.docs) {
    let score = 0;
    for (const t of terms) {
      const f = d.tf.get(t);
      if (!f) continue;
      const n = idx.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += (idf * f * (K1 + 1)) / (f + K1 * (1 - B + (B * d.len) / idx.avgLen));
    }
    if (score > 0) scored.push({ d, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(({ d: { section: s }, score }) => ({
    page: s.page,
    title: s.title,
    heading: s.heading,
    path: `${s.page}#${s.anchor}`,
    score: +score.toFixed(3),
    excerpt: excerpt(s.text),
  }));
}

const search_docs = defineTool({
  name: "search_docs",
  title: "Search the Relay docs",
  description:
    "Search Relay's public docs (bundled, offline) for how-to, auth, errors, limits, retries, webhooks, files and " +
    "pricing rules. Returns the best-matching sections: page, heading, docs path with anchor and an excerpt. For a " +
    "model's input fields use get_model instead; to find a model use search_models.",
  inputSchema: {
    query: z.string().min(1).describe("What to look for, in plain words, e.g. `idempotency key` or `file retention`."),
    limit: z.number().int().min(1).max(10).default(5).describe("How many sections to return (1–10, default 5)."),
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler({ query, limit }) {
    const hits = searchDocs(query, limit);
    if (!hits.length) {
      return textResult(
        `No docs section matches "${query}". For models and their inputs, try search_models or get_model; otherwise rephrase with fewer, more specific words.`,
      );
    }
    return jsonResult(hits, [`Top ${hits.length} docs section(s) for "${query}". Paths are relative to the Relay docs.`]);
  },
});

export const docsTools: ToolDef[] = [search_docs];
