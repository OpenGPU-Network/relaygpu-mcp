# Changelog

## 0.1.7 — 2026-10-15
- `get_usage` pages: 10 keys per answer by default (`limit` up to 1000, `starting_after` = the previous answer's `next_cursor`). An unbounded call listed every key on the account.
- `run_model` submits `async: true` to every model whose request schema has an `async` property (image, video, audio), long-polls up to `wait_seconds` and past it answers the `task_id` with `next: check_task`. A slow image run no longer ends in an edge 524 with the result lost and the charge real. A caller's `async` in `input` is replaced, with a note. Chat models (no `async` in their schema) are sent unchanged and answer inline. A completed replay carries `replayed: true`.
- `run_model` text: the description and `idempotency_key` hold for every route; the same key with a changed input is refused `422 IDEMPOTENCY_KEY_REUSED`. `store_output` and `model` are tool arguments only: a copy inside `input` is dropped and the answer notes it. `mode` is one sentence on `run_model` and `estimate_cost`.
- Errors print `retry_after_seconds` only on 429 and 503, never on a 524 or 504.
- `upload_file({slot: true})` answers `open_url` (the same URL as `put_url`); `next` names both roads: run the curl, or open `open_url` in a browser and pick the file. The hosted server's `upload_file` schema no longer lists `path` (a `path` sent anyway still gets the refusal); the stdio schema keeps it.
- `estimate_cost` refuses a `resolution_tier` the model's `per_image_resolution` / `per_second_video` row does not price, naming the row's keys, instead of falling back to the cheapest cell.
- `search_models`: every row carries `accepts` (`["image"]` for image models whose schema takes an input image, `[]` otherwise). No tool text names a retired model: the examples use `google/gemini-nano-banana-2.1`.
- Hosted: `GET /agent-setup.md` answers the agent-setup page (`agent-setup.md` at the repo root, built into `dist`) as `text/markdown; charset=utf-8` with `Cache-Control: public, max-age=300`, keyless and outside the OAuth-guarded `/mcp`, the same markdown for any `Accept`. The stdio server does not serve it.
- README: the claude.ai / Claude Desktop / ChatGPT row of "Local files" is the browser upload page; long image runs return a `task_id`, never a 524.

## 0.1.6 — 2026-10-15
- `upload_file({slot: true})` (optional `retention`, `filename`): mints a single-use upload slot (`POST /v2/files/slots`) and answers `{put_url, expires_at, curl, next}`; running the `curl` line in a shell uploads the local file with no key there and prints its `url`. This is how an agent on the hosted server (OAuth included) gets a local file to Relay. The hosted refusal of `upload_file(path)` now names `slot: true`. The stdio server accepts `slot` too; `path` is unchanged.
- `search_models({tag: "image-to-image"})` also lists every image-output model whose request schema takes an input image (`image`, `images`, `input_image…`: the Gemini image models, gpt-image-1.5-I2I, gpt-image-2 and its 2.5 variants, FLUX-2-pro, Seedream, Wan 2.7 Image), each row with `accepts: ["image"]`. Other tags are unchanged.
- Image results that carry Relay's own links (`urls` beside `images`, `url` beside `image`) answer those links in place of the base64; the server no longer uploads that base64 itself (results without a Relay link are re-hosted as before). `check_task` without a credential now returns these links instead of omitting the images.
- `estimate_cost`: `duration_seconds` says that an edit of an input video (Kling Omni/o1 `base_video_url`, Motion Control) bills the input video's length.
- README: a "Local files" table per client (hosted + shell: slot and curl; claude.ai / Claude Desktop / ChatGPT: a public URL or the local server; stdio: `path`).

## 0.1.5 — 2026-10-13
- Hosted: "Connect Relay" — OAuth sign-in on the hosted server. With `OAUTH_ISSUER` + `MCP_RESOURCE_URL` set, every `/mcp` request needs a credential (OAuth access token, `X-API-Key` or a Relay Bearer); one without gets `401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="relay"` pointing at the RFC 9728 metadata, which is how clients start the sign-in. A revoked connection stops working within five minutes (the exchanged Relay credential lives 5 minutes; a token Relay refuses is held refused until it expires). README: the OAuth variables per environment (prod issuer `https://relaygpu.com`, resource `https://mcp.relaygpu.com/mcp`; staging issuer `https://staging-back-c54ef4a.opengpu.network`, resource `http://relay-mcp-staging.internal.opengpu.network/mcp`).
- Hosted: "Connect Relay" (OAuth) behind `OAUTH_ISSUER` + `MCP_RESOURCE_URL` (+ `OAUTH_MCP_CLIENT_SECRET`, shared with Relay); with either unset nothing changes. When on: RFC 9728 metadata at `/.well-known/oauth-protected-resource` (and `…/mcp`); every `/mcp` request without a credential gets `401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="relay"` (no anonymous calls, `initialize` included); an access token from the issuer is verified (ES256 against the JWKS, refetched on an unknown `kid` at most once a minute; `aud`; `exp` with 60 s skew) and exchanged at Relay (RFC 8693) for a 5-minute Relay credential cached per token hash. A bad or revoked token → `401 invalid_token`; an unreachable authorization server → `503`. `X-API-Key` and every other Bearer behave as before; the stdio server is unchanged. The server card says a credential is required (OAuth or header) when OAuth is on. No new dependency (`node:crypto`).

## 0.1.4 — 2026-10-12
- Hosted: a request body above the limit gets a clean `413` that names the limit (6.3 MB, which fits a 4 MB `upload_file` base64 argument) instead of a connection reset that proxies reported as `502`.
- README: the Claude Desktop bundle installs switched off; the enable steps (Settings → Extensions → Relay → Configure → key → Save → switch on) are listed, and `get_credits` / `get_usage` are marked as taking a dashboard JWT or a superkey, never a plain key.
- MCP Registry: `server.json` (`com.relaygpu/mcp`: the npm package over stdio with `RELAY_API_KEY`, and `https://mcp.relaygpu.com/mcp` over Streamable HTTP with `X-API-Key`); `mcpName` in `package.json`.
- The `search_docs` index is rebuilt from the current Relay docs.

## 0.1.3 — 2026-10-12
- Hosted endpoint LIVE at `https://mcp.relaygpu.com/mcp` (key-header auth, no OAuth yet). README: the hosted endpoint is the first option for Claude Code, Codex (`--bearer-token-env-var`), Cursor and VS Code; the local server moves to its own section; Claude Desktop keeps the bundle.
- Claude Desktop one-click bundle: `npm run build:mcpb` builds `build/relay.mcpb` (the stdio server in one file on Claude Desktop's built-in Node, the key in a sensitive `user_config` field). Attach it to the GitHub release as `relay.mcpb`; the README links `releases/latest/download/relay.mcpb`.
- Hosted server drains on SIGTERM so a Coolify rolling deploy finishes in-flight calls.
- README install fixes from the setup hunt (2026-10-12): Claude Code `--scope user` and the missing-CLI case; the VS Code section is Copilot's agent, not the Claude Code extension; Claude Desktop leads with the bundle; a Troubleshooting section (GUI PATH, Node 16, Windows `cmd /c`, first-start time).

## 0.1.2 — 2026-10-08
- `serverInfo.version` and `/healthz` report the package version (read from package.json at build time; 0.1.1 still announced 0.1.0).

## 0.1.1 — 2026-10-08
- Install docs for Claude Code, Codex, Cursor (Add to Cursor button) and VS Code (install button); hosted endpoint marked coming soon.
- `engines.node` >= 20 (`@hono/node-server` requires it); the README said >= 18.

## 0.1.0 — 2026-10-08
- First release: 14 tools over stdio and Streamable HTTP.
