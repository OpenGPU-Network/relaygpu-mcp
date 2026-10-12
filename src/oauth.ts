// "Connect Relay" on the hosted server (PRD mcp_oauth_prd F19–F21): the protected-resource metadata, access-token
// verification against the issuer's JWKS (ES256, node:crypto only) and the token exchange that swaps a valid access
// token for a short-lived Relay credential, cached per token hash. Never logs a token, a credential or the secret.
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { log } from "./log.js";

export interface OAuthConfig {
  /** `OAUTH_ISSUER`, e.g. `https://auth.relaygpu.com`. */
  issuer: string;
  /** `MCP_RESOURCE_URL`, e.g. `https://mcp.relaygpu.com/mcp`: the access token's `aud`. */
  resource: string;
  /** `OAUTH_MCP_CLIENT_SECRET`: the `relay-mcp` client's secret, shared with Relay. */
  clientSecret: string;
}

/** OAuth is on only with both the issuer and the resource URL set; otherwise the hosted server behaves as before. */
export function oauthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OAuthConfig | null {
  const issuer = env.OAUTH_ISSUER?.trim().replace(/\/+$/, "");
  const resource = env.MCP_RESOURCE_URL?.trim().replace(/\/+$/, "");
  if (!issuer || !resource) return null;
  return { issuer, resource, clientSecret: env.OAUTH_MCP_CLIENT_SECRET?.trim() ?? "" };
}

export const SCOPE = "relay";
export const PRM_PATH = "/.well-known/oauth-protected-resource";
const CLIENT_ID = "relay-mcp";
const SKEW_S = 60;
const JWKS_REFETCH_MS = 60_000;
const JWKS_RETRY_MS = 5_000;
const CACHE_MARGIN_MS = 30_000;
const CACHE_MAX = 5_000;
const AS_TIMEOUT_MS = 10_000;

export type Resolution =
  | { ok: true; jwt: string }
  /** 401: the token is not good (send the `invalid_token` challenge). 503: the authorization server failed. */
  | { ok: false; status: 401 | 503 };

/** The exchange refused the subject token (revoked grant, inactive account): the client must sign in again. */
class Refused extends Error {}
/** Anything else that keeps us from answering (network, 5xx, our own client auth): never a 401. */
class Unavailable extends Error {}

interface Parsed {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signed: string;
  signature: Buffer;
}

function parseJwt(token: string): Parsed | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const [header, claims] = parts.slice(0, 2).map((p) => JSON.parse(Buffer.from(p, "base64url").toString("utf8")));
    if (!header || typeof header !== "object" || !claims || typeof claims !== "object") return null;
    return { header, claims, signed: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], "base64url") };
  } catch {
    return null;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export interface OAuth {
  config: OAuthConfig;
  /** `<resource origin>/.well-known/oauth-protected-resource`. */
  prmUrl: string;
  /** The RFC 9728 document, serialized. */
  prm: string;
  /** A Bearer value is ours when it is a JWT whose (unverified) `iss` is the issuer. */
  owns(bearer: string): boolean;
  /** Verify, then exchange (or read the cache) into a Relay credential. */
  resolve(token: string): Promise<Resolution>;
}

export function createOAuth(config: OAuthConfig, seams: { fetch?: typeof fetch; now?: () => number } = {}): OAuth {
  const fetchImpl = seams.fetch ?? fetch;
  const now = seams.now ?? Date.now;
  const prmUrl = new URL(config.resource).origin + PRM_PATH;
  const jwksUrl = `${config.issuer}/v2/oauth/jwks`;
  const tokenUrl = `${config.issuer}/v2/oauth/token`;
  const basic = "Basic " + Buffer.from(`${CLIENT_ID}:${config.clientSecret}`).toString("base64");

  let keys = new Map<string, KeyObject>();
  let fetchedAt = -Infinity;
  let jwksFailed = false;
  let loading: Promise<void> | null = null;
  // Insertion order is recency order: a hit is re-inserted, the oldest entry goes first.
  const cache = new Map<string, { jwt: string; until: number }>();
  const inflight = new Map<string, Promise<{ jwt: string; until: number }>>();

  async function loadJwks(): Promise<void> {
    fetchedAt = now();
    try {
      const r = await fetchImpl(jwksUrl, { signal: AbortSignal.timeout(AS_TIMEOUT_MS) });
      if (!r.ok) throw new Unavailable(`jwks_status_${r.status}`);
      const body = (await r.json()) as { keys?: Record<string, unknown>[] };
      const next = new Map<string, KeyObject>();
      for (const jwk of body.keys ?? []) {
        if (jwk?.kty !== "EC" || jwk.crv !== "P-256" || typeof jwk.kid !== "string") continue;
        try {
          next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
        } catch {
          /* a malformed key is skipped */
        }
      }
      keys = next;
      jwksFailed = false;
    } catch (e) {
      jwksFailed = true;
      throw e instanceof Unavailable ? e : new Unavailable(`jwks_${(e as Error).name}`);
    }
  }

  /** The key for `kid`; an unknown kid refetches the JWKS at most once a minute (a failed fetch retries sooner). */
  async function keyFor(kid: string): Promise<KeyObject | undefined> {
    if (loading) await loading.catch(() => undefined);
    const known = keys.get(kid);
    if (known) return known;
    if (now() - fetchedAt < (jwksFailed ? JWKS_RETRY_MS : JWKS_REFETCH_MS)) {
      if (jwksFailed) throw new Unavailable("jwks_unavailable");
      return undefined;
    }
    await (loading ??= loadJwks().finally(() => (loading = null)));
    return keys.get(kid);
  }

  /** null when valid, else the reason it is not. */
  async function invalidReason(p: Parsed | null): Promise<string | null> {
    if (!p || p.header.alg !== "ES256" || typeof p.header.kid !== "string") return "malformed";
    const key = await keyFor(p.header.kid);
    if (!key) return "unknown_kid";
    let good = false;
    try {
      good = verify("sha256", Buffer.from(p.signed), { key, dsaEncoding: "ieee-p1363" }, p.signature);
    } catch {
      /* stays false */
    }
    if (!good) return "bad_signature";
    const { iss, aud, exp } = p.claims;
    if (iss !== config.issuer) return "wrong_iss";
    if (aud !== config.resource) return "wrong_aud";
    if (typeof exp !== "number" || exp + SKEW_S <= now() / 1000) return "expired";
    return null;
  }

  async function exchange(token: string): Promise<{ jwt: string; until: number }> {
    let r: Response;
    try {
      r = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", Authorization: basic },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
          subject_token: token,
          subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
        }).toString(),
        signal: AbortSignal.timeout(AS_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Unavailable(`exchange_${(e as Error).name}`);
    }
    const body = (await r.json().catch(() => ({}))) as { error?: unknown; access_token?: unknown; expires_in?: unknown };
    if (r.status === 400 && body.error === "invalid_grant") throw new Refused("invalid_grant");
    if (!r.ok || typeof body.access_token !== "string") {
      throw new Unavailable(`exchange_status_${r.status}${typeof body.error === "string" ? `_${body.error}` : ""}`);
    }
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 300;
    return { jwt: body.access_token, until: now() + seconds * 1000 - CACHE_MARGIN_MS };
  }

  async function resolve(token: string): Promise<Resolution> {
    const parsed = parseJwt(token);
    const kid = typeof parsed?.header.kid === "string" ? parsed.header.kid : undefined;
    try {
      const reason = await invalidReason(parsed);
      if (reason) {
        log("warning", "oauth_token_rejected", { kid, reason });
        return { ok: false, status: 401 };
      }
      const h = sha256(token);
      const hit = cache.get(h);
      if (hit && hit.until > now()) {
        cache.delete(h);
        cache.set(h, hit);
        return { ok: true, jwt: hit.jwt };
      }
      cache.delete(h);
      let pending = inflight.get(h);
      if (!pending) {
        pending = exchange(token).finally(() => inflight.delete(h));
        inflight.set(h, pending);
      }
      const fresh = await pending;
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(h, fresh);
      log("info", "oauth_exchanged", { kid });
      return { ok: true, jwt: fresh.jwt };
    } catch (e) {
      if (e instanceof Refused) {
        log("warning", "oauth_token_rejected", { kid, reason: e.message });
        return { ok: false, status: 401 };
      }
      log("error", "oauth_unavailable", { kid, reason: e instanceof Unavailable ? e.message : (e as Error).name });
      return { ok: false, status: 503 };
    }
  }

  return {
    config,
    prmUrl,
    prm: JSON.stringify({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Relay",
    }),
    owns: (bearer) => parseJwt(bearer)?.claims.iss === config.issuer,
    resolve,
  };
}
