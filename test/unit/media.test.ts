import { afterEach, describe, expect, it, vi } from "vitest";
import { Relay } from "@relaygpu/client";
import type { ToolContext } from "../../src/context.js";
import { missingCredential } from "../../src/errors.js";
import { EXPIRY_NOTE, decodeMedia, formatResult, sniffMedia } from "../../src/media.js";
import { apiError, mockFetch, TEST_BASE, type Route } from "../helpers/harness.js";
import { b64, fileResponse, pngBytes, wavBytes } from "../fixtures/relay.js";

function ctxFor(routes: Route[], opts: { credential?: boolean; transport?: "stdio" | "http" } = {}) {
  const m = mockFetch(routes);
  const client = new Relay({ apiKey: "relay_sk_unit", baseUrl: TEST_BASE, fetch: m.fetch, retry: false });
  const ctx: ToolContext = {
    transport: opts.transport ?? "stdio",
    catalog: new Relay({ baseUrl: TEST_BASE, fetch: m.fetch }),
    signal: new AbortController().signal,
    hasCredential: opts.credential !== false,
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
    const head = (s: string) => Uint8Array.from(Buffer.from(s.padEnd(16, "\0"), "latin1"));
    expect(sniffMedia(head("\0\0\0\x14ftypqt  "))).toBe("video/quicktime");
    expect(sniffMedia(head("\0\0\0\x18ftypisom"))).toBe("video/mp4");
    expect(sniffMedia(head("\x1a\x45\xdf\xa3"))).toBe("video/webm");
  });

  it("A4 nested data URIs and bare base64 audio are re-hosted once each; large non-media strings stay intact", async () => {
    const { ctx, calls } = ctxFor([filesOk]);
    const wav = b64(wavBytes(400));
    const longText = "lorem ipsum ".repeat(100);
    const uri = `data:image/png;base64,${b64(pngBytes(50))}`;
    const input = { output: { audio: wav, frames: [uri, uri] }, text: longText, poll_url: "https://relay.test/v2/tasks/x" };
    const r = await formatResult(input, { ctx });
    const posts = calls.filter((c) => c.path === "/v2/files");
    expect(posts).toHaveLength(2);
    expect(posts.map((c) => c.headers.get("content-type")).sort()).toEqual(["audio/wav", "image/png"]);
    const body = r.output as typeof input;
    expect(body.text).toBe(longText);
    expect(body.output.audio).toBe(fileResponse().url);
    expect(body.output.frames).toEqual([fileResponse().url, fileResponse().url]);
    expect(r.rehosted).toHaveLength(2);
    expect(input.output.audio).toBe(wav); // the caller's body is never mutated
    expect(r.notes.join("\n")).not.toContain("poll_url");
    expect(r.notes.join("\n")).not.toContain("Result links"); // poll_url is never a result link
    expect(JSON.stringify(r)).not.toContain(wav.slice(0, 40));
  });

  it("F5 an output without media comes back as the same object (no copy)", async () => {
    const { ctx, calls } = ctxFor([filesOk]);
    const body = { data: [{ url: "https://cdn.test/a.png" }], text: "lorem ipsum ".repeat(50) };
    const r = await formatResult(body, { ctx });
    expect(r.output).toBe(body);
    expect(r.rehosted).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("A4 without a credential the base64 is omitted with a note naming the credential (zero POSTs)", async () => {
    const { ctx, calls } = ctxFor([filesOk], { credential: false, transport: "http" });
    const png = b64(pngBytes(600));
    const r = await formatResult({ data: [{ b64_json: png }] }, { ctx });
    expect(calls).toHaveLength(0);
    expect((r.output as any).data[0].b64_json).toBe("<base64 omitted: 600 bytes>");
    expect(r.notes.join("\n")).toContain("X-API-Key");
    expect(JSON.stringify(r)).not.toContain(png.slice(0, 40));
  });

  it("A4 a failed re-host omits the base64 and appends the mapped error", async () => {
    const { ctx } = ctxFor([{ method: "POST", path: "/v2/files", reply: apiError(429, "FILE_QUOTA_EXCEEDED", "Daily free upload quota reached") }]);
    const png = b64(pngBytes(600));
    const r = await formatResult({ data: [{ b64_json: png }] }, { ctx });
    expect((r.output as any).data[0].b64_json).toBe("<base64 omitted: 600 bytes; re-host failed>");
    expect(r.rehosted).toEqual([]);
    expect(r.notes.join("\n")).toContain("code: FILE_QUOTA_EXCEEDED");
    expect(JSON.stringify(r)).not.toContain(png.slice(0, 40));
  });

  it("F5 URL expiry wording per store_output", async () => {
    const { ctx } = ctxFor([]);
    const u = "https://cdn.test/a.mp4";
    const notes = async (o: Omit<Parameters<typeof formatResult>[1], "ctx">) => (await formatResult({ video_url: u }, { ctx, ...o })).notes.join("\n");
    expect(await notes({})).toContain(`${u}: ${EXPIRY_NOTE}`);
    expect(await notes({ store: "none" })).toContain(`${u}: ${EXPIRY_NOTE}`);
    expect(await notes({ store: "applied", sku: "relay30d" })).toContain(`${u}: stored as relay30d (see get_pricing media_storage for its lifetime)`);
    const unsupported = await notes({ store: "unsupported", sku: "relay1d" });
    expect(unsupported).toContain(`${u}: expires 1 h after completion`);
    expect(unsupported).toContain("store_output is not supported by this model; the link expires 1 h after completion");
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
    expect(r.images).toHaveLength(1);
    expect(r.images[0].data).toBe(b64(small));
    expect(r.notes.join("\n")).toContain("https://cdn.test/big.png: image > 1 MB not inlined");
    expect(fetched).toHaveLength(2);
  });

  it("A4 inline_images never fetches plain-http, IP-literal or internal links", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { ctx } = ctxFor([]);
    const links = ["http://cdn.test/a.png", "https://10.0.34.27/a.png", "https://169.254.169.254/x", "https://localhost/a.png", "https://svc.internal/a.png", "https://[::1]/a.png"];
    const r = await formatResult({ links }, { ctx, inlineImages: true });
    expect(spy).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
  });

  it("A4 without inline_images no URL is fetched", async () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    const { ctx } = ctxFor([]);
    const r = await formatResult({ data: [{ url: "https://cdn.test/small.png" }] }, { ctx });
    expect(spy).not.toHaveBeenCalled();
    expect(r.images).toHaveLength(0);
  });
});
