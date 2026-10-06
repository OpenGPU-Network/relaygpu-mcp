// search_docs: BM25 over the bundled public-docs index (src/generated/docs-index.json, built by
// `npm run build:docs`). Keyless, no network.
import { z } from "zod";
import { defineTool, jsonResult, textResult, type ToolDef } from "../context.js";
import docsIndex from "../generated/docs-index.json";

interface DocSection {
  page: string;
  title: string;
  heading: string;
  anchor: string;
  text: string;
}

interface DocHit {
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

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t && !STOPWORDS.has(t))
    .map(stem);
}

/** BM25 index, built once at module load: postings per term, a length norm per section. */
const sections: DocSection[] = docsIndex.sections;
const postings = new Map<string, { doc: number; tf: number }[]>();
const norms: number[] = [];
{
  const lens = sections.map((section, doc) => {
    const tf = new Map<string, number>();
    const add = (tokens: string[], w: number) => tokens.forEach((t) => tf.set(t, (tf.get(t) ?? 0) + w));
    add(tokenize(section.text), 1);
    add(tokenize(section.heading), HEADING_WEIGHT);
    add(tokenize(section.title), 1);
    let len = 0;
    for (const [t, n] of tf) {
      let list = postings.get(t);
      if (!list) postings.set(t, (list = []));
      list.push({ doc, tf: n });
      len += n;
    }
    return len;
  });
  const avgLen = lens.reduce((a, n) => a + n, 0) / Math.max(1, lens.length);
  for (const len of lens) norms.push(K1 * (1 - B + (B * len) / avgLen));
}

/** Trims to ≤ max characters on a word boundary (an ellipsis marks the cut). */
export function excerpt(text: string, max = EXCERPT_MAX): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const at = cut.search(/\s\S*$/);
  return (at > max / 2 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

export function searchDocs(query: string, limit = 5): DocHit[] {
  const N = sections.length;
  const scores = new Map<number, number>();
  for (const t of new Set(tokenize(query))) {
    const list = postings.get(t);
    if (!list) continue;
    const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
    for (const { doc, tf } of list) scores.set(doc, (scores.get(doc) ?? 0) + (idf * tf * (K1 + 1)) / (tf + norms[doc]));
  }
  return [...scores]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, limit)
    .map(([doc, score]) => {
      const s = sections[doc];
      return { page: s.page, title: s.title, heading: s.heading, path: `${s.page}#${s.anchor}`, score: +score.toFixed(3), excerpt: excerpt(s.text) };
    });
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
