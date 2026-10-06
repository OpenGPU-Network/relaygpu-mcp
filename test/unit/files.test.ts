import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { filesTools, HOSTED_PATH_REFUSAL } from "../../src/tools/files.js";
import { connect, mockFetch, posts, textOf, type Route } from "../helpers/harness.js";
import { b64, fileResponse, jsonOf, notesOf, pngBytes, wavBytes } from "../fixtures/relay.js";

const filesOk: Route = {
  method: "POST",
  path: "/v2/files",
  reply: (c) => ({ status: 201, json: fileResponse({ retention: c.query.get("retention") ?? (c.body as { retention?: string })?.retention ?? "relay1h" }) }),
};

let dir: string;
let wavPath: string;
const wav = wavBytes(4096);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "relay-mcp-files-"));
  wavPath = join(dir, "voice.wav");
  await writeFile(wavPath, wav);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("upload_file (F6)", () => {
  it("A5 path on stdio streams the file: bytes arrive intact with type and filename", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, transport: "stdio" });
    const r = await s.call("upload_file", { path: wavPath, retention: "relay1d" });
    expect(r.isError).toBeFalsy();
    expect(posts(m.calls)).toHaveLength(1);
    const call = m.calls[0];
    expect(Buffer.from(call.body as Uint8Array).equals(Buffer.from(wav))).toBe(true);
    expect(call.headers.get("content-type")).toBe("audio/wav");
    expect(call.query.get("filename")).toBe("voice.wav");
    expect(call.query.get("retention")).toBe("relay1d");
    const body = jsonOf(r);
    expect(body).toMatchObject({ file_id: "file_abc123", url: fileResponse().url, expires_at: fileResponse().expires_at, retention: "relay1d" });
    expect(body.cost_usd).toBeDefined();
    expect(notesOf(r)).toContain(`This link expires at ${fileResponse().expires_at}; pass it to any *_url input of run_model.`);
    await s.close();
  });

  it("A5 path on the hosted server is refused naming base64 and url (zero POSTs)", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, transport: "http" });
    const r = await s.call("upload_file", { path: wavPath });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(HOSTED_PATH_REFUSAL);
    expect(textOf(r)).toContain("base64");
    expect(textOf(r)).toContain("url");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("F6 missing path and a directory are clear errors (zero POSTs)", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools });
    const missing = await s.call("upload_file", { path: join(dir, "nope.wav") });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("No file at");
    const folder = await s.call("upload_file", { path: dir });
    expect(folder.isError).toBe(true);
    expect(textOf(folder)).toContain("not a regular file");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("F6 exactly one source is required (zero POSTs)", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools });
    for (const args of [{}, { url: "https://x.test/a.png", base64: b64(pngBytes(10)) }]) {
      const r = await s.call("upload_file", args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("exactly one of path, base64 or url");
    }
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("A5 base64 > 4 MB refused, telling to pass a url (zero POSTs, both transports)", async () => {
    const m = mockFetch([filesOk]);
    const big = b64(pngBytes(4 * 1024 * 1024 + 1));
    for (const transport of ["stdio", "http"] as const) {
      const s = await connect({ fetch: m.fetch, tools: filesTools, transport });
      const r = await s.call("upload_file", { base64: big });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("over 4 MB");
      expect(textOf(r)).toContain("url");
      await s.close();
    }
    expect(m.calls).toHaveLength(0);
  });

  it("A5 base64 uploads the decoded bytes (bare and data: URI)", async () => {
    const png = pngBytes(300);
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, transport: "http" });
    for (const base64 of [b64(png), `data:image/png;base64,${b64(png)}`]) {
      const r = await s.call("upload_file", { base64, filename: "cat.png" });
      expect(r.isError).toBeFalsy();
      expect(jsonOf(r).file_id).toBe("file_abc123");
    }
    expect(posts(m.calls)).toHaveLength(2);
    for (const c of m.calls) {
      expect(Buffer.from(c.body as Uint8Array).equals(Buffer.from(png))).toBe(true);
      expect(c.headers.get("content-type")).toBe("image/png");
      expect(c.query.get("filename")).toBe("cat.png");
    }
    await s.close();
  });

  it("A5 url → POST /v2/files JSON {url, retention}", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, transport: "http" });
    const r = await s.call("upload_file", { url: "https://example.test/in.mp4", retention: "relay7d" });
    expect(r.isError).toBeFalsy();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0].body).toEqual({ url: "https://example.test/in.mp4", retention: "relay7d" });
    expect(m.calls[0].headers.get("content-type")).toBe("application/json");
    expect(jsonOf(r).retention).toBe("relay7d");
    await s.close();
  });

  it("F6 without a credential: MISSING_CREDENTIALS and zero POSTs", async () => {
    const m = mockFetch([filesOk]);
    const s = await connect({ fetch: m.fetch, tools: filesTools, credential: null });
    const r = await s.call("upload_file", { url: "https://example.test/in.mp4" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });

  it("F6 a local file over 100 MB is refused before any upload", async () => {
    const dir = await mkdtemp(join(tmpdir(), "relay-mcp-big-"));
    const p = join(dir, "big.mp4");
    try {
      await writeFile(p, "");
      await truncate(p, 100 * 1024 * 1024 + 1); // sparse: no 100 MB written
      const m = mockFetch([filesOk]);
      const s = await connect({ fetch: m.fetch, tools: filesTools });
      const r = await s.call("upload_file", { path: p });
      expect(r.isError).toBe(true);
      expect(JSON.stringify(r)).toContain("100 MB");
      expect(textOf(r)).toContain("FileTooLargeError");
      expect(textOf(r)).toContain("code: FILE_TOO_LARGE");
      expect(m.calls).toHaveLength(0);
      await s.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
