import { describe, expect, it } from "vitest";
import { docsTools, searchDocs, excerpt, EXCERPT_MAX } from "../../src/tools/docs.js";
import index from "../../src/generated/docs-index.json";
import { connect, mockFetch, textOf } from "../helpers/harness.js";

describe("docs index (generated from relay-v2/docs)", () => {
  it("has sections, none from reference/api-explorer/ or SUMMARY.md", () => {
    expect(index.sections.length).toBeGreaterThan(50);
    expect(index.sections.some((s) => s.page.startsWith("reference/api-explorer/"))).toBe(false);
    expect(index.sections.some((s) => s.page === "SUMMARY.md")).toBe(false);
  });

  it("splits outside fenced code only (a `# comment` in a bash block is not a heading)", () => {
    expect(index.sections.some((s) => s.heading === "Everything that exhausted its retries")).toBe(false);
  });
});

describe("search_docs (A7)", () => {
  it('"idempotency key" → the Safe retries section of Tasks & Webhooks first', () => {
    const [top] = searchDocs("idempotency key");
    expect(top.page).toBe("reference/async-webhooks.md");
    expect(top.heading).toBe("Safe retries (`Idempotency-Key`)");
    expect(top.path).toBe("reference/async-webhooks.md#safe-retries-idempotency-key");
  });

  it('"retention" → the files page first (its Retention section)', () => {
    const [top] = searchDocs("retention");
    expect(top.page).toBe("endpoints/files.md");
    expect(top.heading).toBe("Retention");
  });

  it("excerpts are ≤ 1,200 chars for every section, cut on a word boundary", () => {
    for (const s of index.sections) expect(excerpt(s.text).length).toBeLessThanOrEqual(EXCERPT_MAX);
    const long = index.sections.find((s) => s.text.length > EXCERPT_MAX)!;
    const e = excerpt(long.text);
    expect(e.endsWith("…")).toBe(true);
    expect(long.text.startsWith(e.slice(0, -1))).toBe(true);
    expect(/\s/.test(long.text[e.length - 1])).toBe(true);
  });

  it("tool: keyless, no network, limit honoured, no-hit note points at search_models/get_model", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: docsTools, credential: null });
    const r = await s.call("search_docs", { query: "webhook signature", limit: 2 });
    expect(r.isError).toBeFalsy();
    const hits = JSON.parse((r.content.at(-1) as { text: string }).text);
    expect(hits).toHaveLength(2);
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(["excerpt", "heading", "page", "path", "score", "title"]);
    const none = await s.call("search_docs", { query: "zzqqxx" });
    expect(none.isError).toBeFalsy();
    expect(textOf(none)).toContain("search_models");
    expect(textOf(none)).toContain("get_model");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });
});
