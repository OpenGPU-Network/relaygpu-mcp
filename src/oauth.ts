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
  issuer: string;
  /** `<resource origin>/.well-known/oauth-protected-resource`. */
  prmUrl: string;
  /** The RFC 9728 document, serialized. */
  prm: string;
  /**
   * null when the Bearer is not ours (not a JWT whose unverified `iss` is the issuer: a dashboard JWT passes through);
   * else verify, then exchange (or read the cache) into a Relay credential.
   */
  resolve(bearer: string): Promise<Resolution | null>;
}

interface Entry {
  jwt: string;
  /** ms: the earlier of the credential's expiry (less the margin) and the access token's own. */
  until: number;
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
  // Insertion order is recency order: a hit is re-inserted, the oldest entry goes first. `refused` holds tokens the
  // exchange turned away (revoked grant) until they expire, so a disconnected client does not hit Relay per request.
  const cache = new Map<string, Entry>();
  const refused = new Map<string, number>();
  const inflight = new Map<string, Promise<Entry>>();

  function remember<V>(map: Map<string, V>, h: string, value: V) {
    map.delete(h);
    if (map.size >= CACHE_MAX) map.delete(map.keys().next().value as string);
    map.set(h, value);
  }

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

  async function exchange(token: string, tokenExpMs: number): Promise<Entry> {
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
    return { jwt: body.access_token, until: Math.min(now() + seconds * 1000 - CACHE_MARGIN_MS, tokenExpMs) };
  }

  async function resolve(bearer: string): Promise<Resolution | null> {
    const parsed = parseJwt(bearer);
    if (parsed?.claims.iss !== config.issuer) return null;
    const kid = typeof parsed.header.kid === "string" ? parsed.header.kid : undefined;
    const h = sha256(bearer);
    const hit = cache.get(h);
    if (hit && hit.until > now()) {
      remember(cache, h, hit); // a verified token's credential: no second signature check
      return { ok: true, jwt: hit.jwt };
    }
    cache.delete(h);
    try {
      if ((refused.get(h) ?? 0) > now()) throw new Refused("refused_cached");
      const reason = await invalidReason(parsed);
      if (reason) throw new Refused(reason);
      let pending = inflight.get(h);
      if (!pending) {
        const tokenExpMs = ((parsed.claims.exp as number) + SKEW_S) * 1000;
        pending = exchange(bearer, tokenExpMs)
          .then((fresh) => {
            remember(cache, h, fresh);
            log("info", "oauth_exchanged", { kid });
            return fresh;
          })
          .catch((e) => {
            if (e instanceof Refused) remember(refused, h, tokenExpMs);
            throw e;
          })
          .finally(() => inflight.delete(h));
        inflight.set(h, pending);
      }
      return { ok: true, jwt: (await pending).jwt };
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
    issuer: config.issuer,
    prmUrl,
    prm: JSON.stringify({
      resource: config.resource,
      authorization_servers: [config.issuer],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Relay",
    }),
    resolve,
  };
}
