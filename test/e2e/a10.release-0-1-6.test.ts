// 0.1.6 against staging (PRD mcp_0_1_6 A2–A4): the hosted refusal names slot mode; upload_file(slot) → the curl
// line, run with the real curl → a link; Gemini edits that link and answers Relay's own `urls` (no MCP re-host);
// search_models(image-to-image) finds the editors by schema. Billed: one Gemini image; the slot upload is free (relay1h).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { Relay } from "@relaygpu/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, BASE_URL, HAS_BASE, HAS_KEY, mcpHttp, startHosted, textOf, type McpHandle } from "./harness.js";
import { jsonOf } from "../fixtures/relay.js";

/** A valid size×size solid-colour PNG (the CRCs included), so a model can actually read it. */
function solidPng(size: number, rgb: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Buffer) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    td.copy(out, 4);
    out.writeUInt32BE(crc(td), 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const EDITORS = [
  "google/gemini-2.5-flash-image",
  "google/gemini-3-pro-image",
  "google/gemini-3.1-flash-image-preview",
  "google/gemini-nano-banana-2.1",
  "openai/gpt-image-1.5-I2I",
  "openai/gpt-image-2",
  "black-forest-labs/FLUX-2-pro",
];

// One hosted server for the file (a second start on the same port right after a close resets the client's socket).
let hosted: Awaited<ReturnType<typeof startHosted>> | undefined;
beforeAll(async () => {
  if (HAS_BASE) hosted = await startHosted();
});
afterAll(async () => {
  await hosted?.close();
});

describe.skipIf(!HAS_BASE)("0.1.6 A3 search_models(image-to-image) by schema (keyless)", () => {
  it("A3 lists the Gemini editors, gpt-image-1.5-I2I, gpt-image-2 and FLUX-2-pro, each accepts: [image]", async () => {
    const mcp = await mcpHttp(hosted!.url);
    try {
      const r = await mcp.call("search_models", { tag: "image-to-image" });
      expect(r.isError, textOf(r)).toBeFalsy();
      const models = jsonOf(r).models as { name: string; accepts?: string[] }[];
      for (const name of EDITORS) {
        const row = models.find((m) => m.name === name);
        expect(row, name).toBeDefined();
        expect(row!.accepts, name).toEqual(["image"]);
      }
      for (const m of models) expect(m.accepts, m.name).toEqual(["image"]);
    } finally {
      await mcp.close();
    }
  });
});

describe.skipIf(!HAS_KEY)("0.1.6 A2/A4 slot mode and Relay's links (hosted, X-API-Key)", () => {
  const dir = mkdtempSync(join(tmpdir(), "relaygpu-mcp-016-"));
  const pngPath = join(dir, "red.png");
  const uploaded: string[] = [];
  let mcp: McpHandle;

  beforeAll(async () => {
    writeFileSync(pngPath, solidPng(256, [220, 30, 30]));
    mcp = await mcpHttp(hosted!.url, { "X-API-Key": API_KEY });
  });
  afterAll(async () => {
    await mcp?.close();
    const relay = new Relay({ apiKey: API_KEY, baseUrl: BASE_URL });
    for (const id of uploaded) await relay.files.delete(id).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("A2 hosted upload_file(path) is refused naming slot: true", async () => {
    const r = await mcp.call("upload_file", { path: "/tmp/x.png" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("slot: true");
  });

  it("A1/A4 (key stand-in) slot → curl → link → Gemini edit answers Relay's urls, no MCP re-host (1 billed image)", async () => {
    const slot = await mcp.call("upload_file", { slot: true, filename: "red.png" });
    expect(slot.isError, textOf(slot)).toBeFalsy();
    const s = jsonOf(slot);
    expect(Object.keys(s).sort()).toEqual(["curl", "expires_at", "next", "put_url"]);
    expect(s.curl).toContain(s.put_url);
    expect(s.next).toBe("run the curl, then pass the returned url to run_model");

    // The agent's shell: the curl line exactly as given, <file> replaced by the local path, no credential.
    const argv = (s.curl as string).split(/\s+/).map((a) => (a === "<file>" ? pngPath : a));
    expect(argv[0]).toBe("curl");
    const out = execFileSync("curl", ["-sS", "--fail-with-body", ...argv.slice(1)], { encoding: "utf8", timeout: 60_000 });
    const file = JSON.parse(out) as { file_id: string; url: string };
    uploaded.push(file.file_id);
    expect(file.url).toMatch(/^https:\/\//);

    const r = await mcp.call("run_model", { model: "google/gemini-nano-banana-2.1", input: { image: file.url, prompt: "make the square blue" } });
    expect(r.isError, textOf(r)).toBeFalsy();
    const env = jsonOf(r);
    expect(env.status).toBe("completed");
    expect(env.rehosted).toBeUndefined(); // the MCP made no upload of its own
    const urls = env.output.urls as string[];
    expect(urls.length).toBeGreaterThan(0);
    expect(urls[0]).toMatch(/^https:\/\/cdn\./);
    expect(env.output.images).toEqual(urls);
  });
});
