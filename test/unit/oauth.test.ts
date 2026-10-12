// "Connect Relay" on the hosted server (PRD mcp_oauth_prd F19–F21, A14–A15), offline: a local authorization-server
// stub (node:http) serves the JWKS and the token endpoint; the test mints ES256 access tokens with its own P-256 key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { startHostedServer } from "../../src/hosted.js";
import { createOAuth, oauthConfigFromEnv, type OAuthConfig } from "../../src/oauth.js";
import { mockFetch, TEST_BASE } from "../helpers/harness.js";

const RESOURCE = "https://mcp-test.relaygpu.com/mcp";
const PRM_URL = "https://mcp-test.relaygpu.com/.well-known/oauth-protected-resource";
const SECRET = "test-mcp-client-secret-" + randomBytes(8).toString("hex");
const KID = "kid-test-1";
const KEY = "relay_sk_oauth_unit_key_7";
const CHALLENGE = `Bearer resource_metadata="${PRM_URL}", scope="relay"`;
const INVALID = `Bearer error="invalid_token", resource_metadata="${PRM_URL}"`;

const signing = generateKeyPairSync("ec", { namedCurve: "P-256" });
const stranger = generateKeyPairSync("ec", { namedCurve: "P-256" });

// --- authorization-server stub ---------------------------------------------------------------------------------
type ExchangeMode = "ok" | "invalid_grant" | "500";
const as = { jwks: 0, exchanges: 0, mode: "ok" as ExchangeMode, issued: [] as string[], badAuth: 0, badBody: 0 };
let asServer: Server;
let ISSUER = "";

function startAs(): Promise<void> {
  asServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const json = (status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
      if (req.method === "GET" && req.url === "/v2/oauth/jwks") {
        as.jwks++;
        return json(200, { keys: [{ ...signing.publicKey.export({ format: "jwk" }), kid: KID, use: "sig", alg: "ES256" }] });
      }
      if (req.method === "POST" && req.url === "/v2/oauth/token") {
        as.exchanges++;
        if (req.headers.authorization !== "Basic " + Buffer.from(`relay-mcp:${SECRET}`).toString("base64")) {
          as.badAuth++;
          return json(401, { error: "invalid_client", error_description: "client authentication failed" });
        }
        const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
        if (
          req.headers["content-type"] !== "application/x-www-form-urlencoded" ||
          form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:token-exchange" ||
          form.get("subject_token_type") !== "urn:ietf:params:oauth:token-type:access_token" ||
          !form.get("subject_token")
        ) {
          as.badBody++;
          return json(400, { error: "invalid_request", error_description: "bad exchange body" });
        }
        if (as.mode === "invalid_grant") return json(400, { error: "invalid_grant", error_description: "the connection was revoked" });
        if (as.mode === "500") return json(500, { detail: "boom" });
        const credential = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ via: "mcp", n: as.issued.length })).toString("base64url")}.relaycredsig`;
        as.issued.push(credential);
        return json(200, { access_token: credential, issued_token_type: "urn:ietf:params:oauth:token-type:jwt", token_type: "Bearer", expires_in: 300 });
      }
      json(404, { detail: "not found" });
    });
  });
  return new Promise((resolve) =>
    asServer.listen(0, "127.0.0.1", () => {
      const a = asServer.address();
      ISSUER = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
      resolve();
    }),
  );
}

// --- token minting ---------------------------------------------------------------------------------------------
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
const tokens: string[] = [];
function mint(over: Record<string, unknown> = {}, opts: { kid?: string; key?: KeyObject; alg?: string } = {}): string {
  const nowS = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUER, sub: "cus_test", aud: RESOURCE, client_id: "https://client.example/meta.json", scope: "relay", gid: "grant_1", jti: randomBytes(16).toString("hex"), iat: nowS, exp: nowS + 3600, ...over };
  const head = b64({ alg: opts.alg ?? "ES256", typ: "JWT", kid: opts.kid ?? KID });
  const body = b64(claims);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), { key: opts.key ?? signing.privateKey, dsaEncoding: "ieee-p1363" });
  const t = `${head}.${body}.${sig.toString("base64url")}`;
  tokens.push(t);
  return t;
}

// --- captured logs (A13-style grep) ----------------------------------------------------------------------------
const logLines: string[] = [];
const realWrite = process.stderr.write.bind(process.stderr);
const prevLevel = process.env.LOG_LEVEL;

// --- the hosted server under test (SDK traffic goes to the mock fetch) -------------------------------------------
const m = mockFetch([
  { method: "GET", path: "/v2/customer/credits", reply: { json: { balance: 3.5 } } },
  { method: "GET", path: "/v2/models", reply: { json: { auto: {}, direct: {}, opengpu: {} } } },
]);
let hosted: Awaited<ReturnType<typeof startHostedServer>>;
let config: OAuthConfig;

beforeAll(async () => {
  process.env.LOG_LEVEL = "debug";
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    logLines.push(String(chunk));
    return (realWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write;
  await startAs();
  config = { issuer: ISSUER, resource: RESOURCE, clientSecret: SECRET };
  hosted = await startHostedServer({ port: 0, host: "127.0.0.1", baseUrl: TEST_BASE, fetch: m.fetch, oauth: config });
});

afterAll(async () => {
  await hosted.close();
  await new Promise<void>((r) => asServer.close(() => r()));
  process.stderr.write = realWrite;
  if (prevLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = prevLevel;
});

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } });
const LIST = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function post(body: string, headers: Record<string, string> = {}) {
  return fetch(hosted.url + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body });
}

async function callCredits(headers: Record<string, string>) {
  const client = new Client({ name: "oauth-unit", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(hosted.url + "/mcp"), { requestInit: { headers } }));
  const r = (await client.callTool({ name: "get_credits", arguments: {} })) as CallToolResult;
  await client.close();
  return r;
}

const creditsCalls = () => m.calls.filter((c) => c.path === "/v2/customer/credits");

describe("A14 F19 F20 protected-resource metadata and the challenge", () => {
  it("both PRM paths answer the RFC 9728 document, public, CORS *", async () => {
    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      const r = await fetch(hosted.url + p);
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      expect(await r.json()).toEqual({ resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ["relay"], bearer_methods_supported: ["header"], resource_name: "Relay" });
    }
  });

  it("initialize and tools/list without a credential → 401 with the exact WWW-Authenticate, exposed to CORS", async () => {
    for (const body of [INIT, LIST]) {
      const r = await post(body);
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe(CHALLENGE);
      expect(r.headers.get("access-control-expose-headers")).toContain("WWW-Authenticate");
      expect((await r.json()).error.message).toMatch(/Authentication required/);
    }
    expect((await fetch(hosted.url + "/mcp")).status).toBe(401);
    expect(m.calls).toHaveLength(0);
  });

  it("healthz, the server card and metrics stay public; the card says a credential is required (OAuth or header)", async () => {
    expect((await fetch(hosted.url + "/healthz")).status).toBe(200);
    expect((await fetch(hosted.url + "/metrics")).status).toBe(200);
    const card = await (await fetch(hosted.url + "/.well-known/mcp/server-card.json")).json();
    expect(card.authentication.required).toBe(true);
    expect(card.authentication.schemes.map((s: { type: string }) => s.type)).toEqual(["oauth2", "header", "bearer"]);
    expect(card.authentication.schemes[0]).toMatchObject({ resource_metadata: PRM_URL, authorization_servers: [ISSUER], scopes: ["relay"] });
    expect(card.tools).toHaveLength(14);
  });
});

describe("A15 F21 access tokens", () => {
  it("a valid token is exchanged exactly once; the Relay credential reaches the SDK as jwt; a second call makes no exchange", async () => {
    const token = mint();
    const before = { ex: as.exchanges, credits: creditsCalls().length };
    const r1 = await callCredits({ Authorization: `Bearer ${token}` });
    expect(r1.isError).toBeFalsy();
    expect(as.exchanges - before.ex).toBe(1);
    expect(as.badAuth + as.badBody).toBe(0);
    const credential = as.issued.at(-1)!;
    const sdk = creditsCalls().slice(before.credits);
    expect(sdk).toHaveLength(1);
    expect(sdk[0].headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(sdk[0].headers.get("x-api-key")).toBeNull();
    // A fresh connection with the same token (initialize + tools/call again): served from the cache.
    const r2 = await callCredits({ Authorization: `Bearer ${token}` });
    expect(r2.isError).toBeFalsy();
    expect(as.exchanges - before.ex).toBe(1);
    expect(creditsCalls().at(-1)!.headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(JSON.stringify([r1, r2])).not.toContain(credential);
  });

  it.each([
    ["wrong aud", () => mint({ aud: "https://elsewhere.example/mcp" })],
    ["bad signature", () => mint({}, { key: stranger.privateKey })],
    ["expired (past the 60 s skew)", () => mint({ exp: Math.floor(Date.now() / 1000) - 120 })],
    ["unknown kid", () => mint({}, { kid: "kid-unknown", key: stranger.privateKey })],
    ["wrong alg", () => mint({}, { alg: "ES384" })],
  ])("%s → 401 invalid_token, no exchange", async (_, make) => {
    const before = as.exchanges;
    const r = await post(INIT, { Authorization: `Bearer ${make()}` });
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(INVALID);
    expect(as.exchanges).toBe(before);
  });

  it("an expiry inside the 60 s skew still passes", async () => {
    const r = await post(INIT, { Authorization: `Bearer ${mint({ exp: Math.floor(Date.now() / 1000) - 30 })}` });
    expect(r.status).toBe(200);
  });

  it("an exchange refused as invalid_grant (revoked) → 401 invalid_token", async () => {
    as.mode = "invalid_grant";
    try {
      const r = await post(INIT, { Authorization: `Bearer ${mint()}` });
      expect(r.status).toBe(401);
      expect(r.headers.get("www-authenticate")).toBe(INVALID);
    } finally {
      as.mode = "ok";
    }
  });

  it("an exchange answered 500 → 503 (never 401: the client must not loop into re-auth)", async () => {
    as.mode = "500";
    try {
      const r = await post(INIT, { Authorization: `Bearer ${mint()}` });
      expect(r.status).toBe(503);
      expect(r.headers.get("www-authenticate")).toBeNull();
      expect((await r.json()).error.message).toMatch(/authorization server/);
    } finally {
      as.mode = "ok";
    }
  });

  it("X-API-Key and a dashboard-JWT Bearer reach the SDK exactly as before, with no AS traffic", async () => {
    const before = { ex: as.exchanges, jwks: as.jwks };
    await callCredits({ "X-API-Key": KEY });
    expect(creditsCalls().at(-1)!.headers.get("x-api-key")).toBe(KEY);
    await callCredits({ Authorization: `Bearer ${KEY}` });
    expect(creditsCalls().at(-1)!.headers.get("x-api-key")).toBe(KEY);
    const dashboard = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "cus_test", iss: "relay-dashboard" })}.c2ln`;
    await callCredits({ Authorization: `Bearer ${dashboard}` });
    expect(creditsCalls().at(-1)!.headers.get("authorization")).toBe(`Bearer ${dashboard}`);
    // X-API-Key wins over an OAuth Bearer, as before.
    await callCredits({ "X-API-Key": KEY, Authorization: `Bearer ${mint()}` });
    expect(creditsCalls().at(-1)!.headers.get("x-api-key")).toBe(KEY);
    expect(as.exchanges).toBe(before.ex);
    expect(as.jwks).toBe(before.jwks);
  });
});

describe("A15 the verifier's clocked behaviour", () => {
  function clocked() {
    let t = Date.now();
    const oauth = createOAuth({ issuer: ISSUER, resource: RESOURCE, clientSecret: SECRET }, { now: () => t });
    return { oauth, advance: (ms: number) => (t += ms) };
  }

  it("an unknown kid refetches the JWKS exactly once (at most once a minute)", async () => {
    const { oauth, advance } = clocked();
    expect(await oauth.resolve(mint())).toMatchObject({ ok: true });
    advance(61_000);
    const before = as.jwks;
    const unknown = () => mint({}, { kid: "kid-rotated", key: stranger.privateKey });
    expect(await oauth.resolve(unknown())).toEqual({ ok: false, status: 401 });
    expect(await oauth.resolve(unknown())).toEqual({ ok: false, status: 401 });
    expect(as.jwks - before).toBe(1);
  });

  it("the Relay credential is cached until 30 s before its expiry, then exchanged again", async () => {
    const { oauth, advance } = clocked();
    const token = mint();
    const before = as.exchanges;
    await oauth.resolve(token);
    advance(260_000);
    await oauth.resolve(token);
    expect(as.exchanges - before).toBe(1);
    advance(15_000); // 275 s: inside the 30 s margin
    await oauth.resolve(token);
    expect(as.exchanges - before).toBe(2);
  });

  it("concurrent first calls with one token share one exchange", async () => {
    const { oauth } = clocked();
    const token = mint();
    const before = as.exchanges;
    const rs = await Promise.all([oauth.resolve(token), oauth.resolve(token), oauth.resolve(token)]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(as.exchanges - before).toBe(1);
  });

  it("a wrong client secret (invalid_client) is the server's fault: 503, never 401", async () => {
    const oauth = createOAuth({ issuer: ISSUER, resource: RESOURCE, clientSecret: "wrong" });
    expect(await oauth.resolve(mint())).toEqual({ ok: false, status: 503 });
  });

  it("an unreachable AS is 503", async () => {
    const oauth = createOAuth({ issuer: "http://127.0.0.1:1", resource: RESOURCE, clientSecret: SECRET });
    expect(await oauth.resolve(mint({ iss: "http://127.0.0.1:1" }))).toEqual({ ok: false, status: 503 });
  });
});

describe("OAuth off (env unset) keeps today's behaviour", () => {
  it("oauthConfigFromEnv needs both the issuer and the resource", () => {
    expect(oauthConfigFromEnv({})).toBeNull();
    expect(oauthConfigFromEnv({ OAUTH_ISSUER: "https://auth.relaygpu.com" })).toBeNull();
    expect(oauthConfigFromEnv({ MCP_RESOURCE_URL: RESOURCE })).toBeNull();
    expect(oauthConfigFromEnv({ OAUTH_ISSUER: "https://auth.relaygpu.com/", MCP_RESOURCE_URL: RESOURCE, OAUTH_MCP_CLIENT_SECRET: "s" })).toEqual({
      issuer: "https://auth.relaygpu.com",
      resource: RESOURCE,
      clientSecret: "s",
    });
  });

  it("no PRM routes, keyless initialize answers, the card says not required, an OAuth-shaped Bearer is a plain JWT", async () => {
    const sdk = mockFetch([{ method: "GET", path: "/v2/customer/credits", reply: { json: { balance: 1 } } }]);
    const off = await startHostedServer({ port: 0, host: "127.0.0.1", baseUrl: TEST_BASE, fetch: sdk.fetch });
    try {
      expect((await fetch(off.url + "/.well-known/oauth-protected-resource")).status).toBe(404);
      expect((await fetch(off.url + "/.well-known/oauth-protected-resource/mcp")).status).toBe(404);
      const r = await fetch(off.url + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: INIT });
      expect(r.status).toBe(200);
      const card = await (await fetch(off.url + "/.well-known/mcp/server-card.json")).json();
      expect(card.authentication.required).toBe(false);
      const token = mint();
      const client = new Client({ name: "off", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(off.url + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      await client.callTool({ name: "get_credits", arguments: {} });
      await client.close();
      expect(sdk.calls.at(-1)!.headers.get("authorization")).toBe(`Bearer ${token}`);
    } finally {
      await off.close();
    }
  });
});

describe("N1 secrets never reach a log line", () => {
  it("no access token, Relay credential or client secret in captured logs, while the OAuth events were logged", () => {
    const all = logLines.join("");
    expect(all).toMatch(/oauth_exchanged/);
    expect(all).toMatch(/oauth_token_rejected/);
    expect(all).toMatch(/oauth_unavailable/);
    expect(tokens.length).toBeGreaterThan(5);
    expect(as.issued.length).toBeGreaterThan(0);
    for (const t of tokens) {
      expect(all).not.toContain(t);
      expect(all).not.toContain(t.split(".")[2]);
    }
    for (const c of as.issued) expect(all).not.toContain(c);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain(Buffer.from(`relay-mcp:${SECRET}`).toString("base64"));
  });
});
