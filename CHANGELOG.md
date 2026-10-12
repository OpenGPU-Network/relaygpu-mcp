# Changelog

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
