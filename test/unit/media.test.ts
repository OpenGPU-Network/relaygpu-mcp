import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay } from "@relaygpu/client";
import type { ToolContext } from "../../src/context.js";
import { missingCredential } from "../../src/errors.js";
import { EXPIRY_NOTE, decodeMedia, formatResult, retentionFor, sniffMedia } from "../../src/media.js";
import { apiError, mockFetch, TEST_BASE, type Route } from "../helpers/harness.js";
import { b64, fileResponse, imagesOf, jsonOf, notesOf, pngBytes, wavBytes } from "../fixtures/relay.js";

function ctxFor(routes: Route[], opts: { credential?: boolean; transport?: "stdio" | "http" } = {}) {
  const m = mockFetch(routes);
  const client = new Relay({ apiKey: "relay_sk_unit", baseUrl: TEST_BASE, fetch: m.fetch, retry: false });
  const ctx: ToolContext = {
    transport: opts.transport ?? "stdio",
    catalog: new Relay({ baseUrl: TEST_BASE, fetch: m.fetch }),
    signal: new AbortController().signal,
    client() {
      if (opts.credential === false) throw missingCredential();
      return client;
    },
  };
  return { ctx, calls: m.calls };
}

const filesOk: Route = { method: "POST", path: "/v2/files", reply: (c) => ({ status: 201, json: fileResponse({ retention: c.query.get("retention") }) }) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("media formatting (F5)", () => {
  it("F5 sniffs media by magic bytes only", () => {
    expect(sniffMedia(pngBytes(16))).toBe("image/png");
    expect(sniffMedia(wavBytes(16))).toBe("audio/wav");
    expect(sniffMedia(new TextEncoder().encode("hello world, not media"))).toBeNull();
    expect(decodeMedia("A".repeat(500))).toBeNull(); // valid base64, zero bytes: not media
    expect(decodeMedia(b64(new TextEncoder().encode("x".repeat(400))))).toBeNull(); // base64 text, not media
    expect(decodeMedia(b64(pngBytes(100)))).toBeNull(); // bare base64 under 200 chars is left alone
    expect(decodeMedia(`data:image/png;base64,${b64(pngBytes(20))}`)?.type).toBe("image/png"); // data: URI at any size
    expect(retentionFor(undefined)).toBe("relay1h");
    expect(retentionFor("provider")).toBe("relay1h");
    expect(retentionFor("relay30d")).toBe("relay30d");
  });

  it("A4 nested data URIs and bare base64 audio are re-hosted once each; large non-media strings stay intact", async () => {
    const { ctx, calls } = ctxFor([filesOk]);
    const wav = b64(wavBytes(400));
    const longText = "lorem ipsum ".repeat(100);
    const uri = `data:image/png;base64,${b64(pngBytes(50))}`;
    const r = await formatResult({ output: { audio: wav, frames: [uri, uri] }, text: longText, poll_url: "https://relay.test/v2/tasks/x" }, { ctx });
    const posts = calls.filter((c) => c.path === "/v2/files");
    expect(posts).toHaveLength(2);
    expect(posts.map((c) => c.headers.get("content-type")).sort()).toEqual(["audio/wav", "image/png"]);
    const body = jsonOf(r);
    expect(body.text).toBe(longText);
    expect(body.output.audio).toBe(fileResponse().url);
    expect(body.output.frames).toEqual([fileResponse().url, fileResponse().url]);
    expect(body.rehosted).toHaveLength(2);
    expect(notesOf(r)).not.toContain("poll_url");
    expect(notesOf(r)).not.toContain("Result links"); // poll_url is never a result link
    expect(JSON.stringify(r)).not.toContain(wav.slice(0, 40));
  });

  it("A4 without a credential the base64 is omitted with a note naming the credential (zero POSTs)", async () => {
    const { ctx, calls } = ctxFor([filesOk], { credential: false, transport: "http" });
    const png = b64(pngBytes(600));
    const r = await formatResult({ data: [{ b64_json: png }] }, { ctx });
    expect(calls).toHaveLength(0);
    expect(jsonOf(r).data[0].b64_json).toBe("<base64 omitted: 600 bytes>");
    expect(notesOf(r)).toContain("X-API-Key");
    expect(JSON.stringify(r)).not.toContain(png.slice(0, 40));
  });

  it("A4 a failed re-host omits the base64 and appends the mapped error", async () => {
    const { ctx } = ctxFor([{ method: "POST", path: "/v2/files", reply: apiError(429, "FILE_QUOTA_EXCEEDED", "Daily free upload quota reached") }]);
    const png = b64(pngBytes(600));
    const r = await formatResult({ data: [{ b64_json: png }] }, { ctx });
    expect(r.isError).toBeFalsy();
    expect(jsonOf(r).data[0].b64_json).toBe("<base64 omitted: 600 bytes; re-host failed>");
    expect(notesOf(r)).toContain("code: FILE_QUOTA_EXCEEDED");
    expect(JSON.stringify(r)).not.toContain(png.slice(0, 40));
  });

  it("F5 URL expiry wording per store_output", async () => {
    const { ctx } = ctxFor([]);
    const u = "https://cdn.test/a.mp4";
    expect(notesOf(await formatResult({ video_url: u }, { ctx }))).toContain(`${u}: ${EXPIRY_NOTE}`);
    expect(notesOf(await formatResult({ video_url: u }, { ctx, storeOutput: "provider", storeOutputApplied: true }))).toContain(`${u}: ${EXPIRY_NOTE}`);
    expect(notesOf(await formatResult({ video_url: u }, { ctx, storeOutput: "relay30d", storeOutputApplied: true }))).toContain(
      `${u}: stored as relay30d: kept for 30 days`,
    );
    expect(notesOf(await formatResult({ video_url: u }, { ctx, storeOutput: "relay90d", storeOutputApplied: true }))).toContain("kept per relay90d");
    const notes = await formatResult({ video_url: u }, { ctx, storeOutput: "relay1d", storeOutputApplied: false, notes: ["task_id: t"] });
    expect(notesOf(notes).startsWith("task_id: t")).toBe(true); // caller notes first
    expect(notesOf(notes)).toContain("store_output is not supported by this model; the link expires 1 h after completion");
  });

  it("A4 inline_images fetches a ≤1MB URL image into an image block; >1MB never", async () => {
    const small = pngBytes(2000) as Uint8Array<ArrayBuffer>;
    const fetched: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      fetched.push(url);
      if (url.endsWith("small.png")) return new Response(small, { headers: { "content-type": "image/png", "content-length": String(small.byteLength) } });
      return new Response(pngBytes(16) as Uint8Array<ArrayBuffer>, { headers: { "content-type": "image/png", "content-length": String(2 * 1024 * 1024) } });
    });
    const { ctx } = ctxFor([]);
    const r = await formatResult({ data: [{ url: "https://cdn.test/small.png" }, { url: "https://cdn.test/big.png" }] }, { ctx, inlineImages: true });
    const imgs = imagesOf(r);
    expect(imgs).toHaveLength(1);
    expect(imgs[0].data).toBe(b64(small));
    expect(notesOf(r)).toContain("https://cdn.test/big.png: image > 1 MB not inlined");
    expect(fetched).toHaveLength(2);
  });

  it("A4 inline_images never fetches plain-http, IP-literal or internal links", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { ctx } = ctxFor([]);
    const links = ["http://cdn.test/a.png", "https://10.0.34.27/a.png", "https://169.254.169.254/x", "https://localhost/a.png", "https://svc.internal/a.png", "https://[::1]/a.png"];
    const r = await formatResult({ links }, { ctx, inlineImages: true });
    expect(spy).not.toHaveBeenCalled();
    expect(imagesOf(r)).toHaveLength(0);
  });

  it("A4 without inline_images no URL is fetched", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { ctx } = ctxFor([]);
    const r = await formatResult({ data: [{ url: "https://cdn.test/small.png" }] }, { ctx });
    expect(spy).not.toHaveBeenCalled();
    expect(imagesOf(r)).toHaveLength(0);
  });
});
