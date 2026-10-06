// A5 (F6): stdio upload_file(path) → file_id + url; hosted upload_file(path) refused naming base64 and url;
// hosted upload_file(base64) uploads. A 8 KB wav at the default (free) retention; both files deleted in afterAll.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "@relaygpu/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { API_KEY, BASE_URL, HAS_KEY, URL_RE, fieldOf, mcpHttp, mcpStdio, startHosted, textOf, tinyWav, type McpHandle } from "./harness.js";

describe.skipIf(!HAS_KEY)("A5 upload_file", () => {
  const dir = mkdtempSync(join(tmpdir(), "relaygpu-mcp-a5-"));
  const wavPath = join(dir, "tone.wav");
  const wav = tinyWav();
  const uploaded: string[] = [];
  let hosted: Awaited<ReturnType<typeof startHosted>>;
  let mcp: McpHandle;

  beforeAll(async () => {
    writeFileSync(wavPath, wav);
    hosted = await startHosted();
    mcp = await mcpHttp(hosted.url, { "X-API-Key": API_KEY });
  });
  afterAll(async () => {
    await mcp?.close();
    await hosted?.close();
    const relay = new Relay({ apiKey: API_KEY, baseUrl: BASE_URL });
    for (const id of uploaded) await relay.files.delete(id).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("A5 stdio upload_file(path) → file_id + url", async () => {
    const stdio = await mcpStdio({ RELAY_API_KEY: API_KEY, RELAY_BASE_URL: BASE_URL });
    try {
      const r = await stdio.call("upload_file", { path: wavPath, filename: "tone.wav" });
      expect(r.isError, textOf(r)).toBeFalsy();
      const fileId = fieldOf(r, "file_id");
      if (fileId) uploaded.push(fileId);
      expect(fileId).toBeTruthy();
      expect(fieldOf(r, "url")).toMatch(URL_RE);
    } finally {
      await stdio.close();
    }
  });

  it("A5 hosted upload_file(path) is refused naming base64 and url", async () => {
    const r = await mcp.call("upload_file", { path: wavPath });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("base64");
    expect(textOf(r)).toContain("url");
  });

  it("A5 hosted upload_file(base64) uploads", async () => {
    const r = await mcp.call("upload_file", { base64: wav.toString("base64"), filename: "tone.wav" });
    expect(r.isError, textOf(r)).toBeFalsy();
    const fileId = fieldOf(r, "file_id");
    if (fileId) uploaded.push(fileId);
    expect(fileId).toBeTruthy();
    expect(fieldOf(r, "url")).toMatch(URL_RE);
  });
});
