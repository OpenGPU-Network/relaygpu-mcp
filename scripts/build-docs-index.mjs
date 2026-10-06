#!/usr/bin/env node
// Builds src/generated/docs-index.json (the search_docs index) from the public docs tree (relay-v2/docs).
//   npm run build:docs -- --docs /path/to/relay-v2/docs
// Markdown only; SUMMARY.md and reference/api-explorer/ are skipped. One section per ATX heading (# .. ####)
// outside fenced code; GitBook `{% %}` tags and HTML comments are dropped; code blocks are kept.
// Deterministic: files sorted once by docs-relative path, no timestamp, so a rebuild over unchanged docs diffs clean.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), "../src/generated/docs-index.json");
const SKIP_FILES = new Set(["SUMMARY.md"]);
const SKIP_DIRS = ["reference/api-explorer/"];

function usage(msg) {
  process.stderr.write(`${msg}\nusage: node scripts/build-docs-index.mjs --docs <path to relay-v2/docs>\n`);
  process.exit(2);
}

function argValue(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].startsWith(name + "=")) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".md")) out.push(p);
  }
  return out;
}

/** GitBook-style anchor: lowercase, punctuation dropped, whitespace → `-`. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

/** Heading text as a reader sees it: inline markdown links reduced to their label. */
const plainHeading = (h) => h.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+#+\s*$/, "").trim();

function clean(md) {
  return md.replace(/<!--[\s\S]*?-->/g, "").replace(/\{%[\s\S]*?%\}/g, "");
}

function sectionsOf(page, md) {
  const lines = clean(md).split(/\r?\n/);
  const sections = [];
  let title = null;
  let current = { heading: null, lines: [] };
  let fence = null;
  const flush = () => {
    const text = current.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
    if (current.heading !== null || text) sections.push({ heading: current.heading, text });
  };
  for (const line of lines) {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (line.trim().startsWith(fence)) fence = null;
      current.lines.push(line);
      continue;
    }
    const h = !fence && line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (h) {
      flush();
      const heading = plainHeading(h[2]);
      if (h[1].length === 1 && title === null) title = heading;
      current = { heading, lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  flush();
  title ??= page;
  const seen = new Map();
  return sections
    .filter((s) => s.text)
    .map((s) => {
      const heading = s.heading ?? title;
      const base = slug(heading);
      const n = seen.get(base) ?? 0;
      seen.set(base, n + 1);
      return { page, title, heading, anchor: n ? `${base}-${n}` : base, text: s.text };
    });
}

const docsArg = argValue("--docs");
if (!docsArg) usage("missing --docs <path>");
const docs = resolve(docsArg);
try {
  if (!statSync(docs).isDirectory()) usage(`--docs ${docs} is not a directory`);
} catch {
  usage(`--docs ${docs} does not exist`);
}

const files = walk(docs)
  .map((p) => relative(docs, p).split(sep).join("/"))
  .filter((p) => !SKIP_FILES.has(p) && !SKIP_DIRS.some((d) => p.startsWith(d)))
  .sort();

const sections = files.flatMap((page) => sectionsOf(page, readFileSync(join(docs, page), "utf8")));
const index = { source: "relay-v2/docs", pages: files.length, sections };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(index, null, 1) + "\n");
process.stderr.write(`docs index: ${files.length} pages, ${sections.length} sections → ${relative(process.cwd(), OUT)}\n`);
