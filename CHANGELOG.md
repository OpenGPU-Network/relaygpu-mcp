# Changelog

## Unreleased
- Claude Desktop one-click bundle: `npm run build:mcpb` builds `build/relay.mcpb` (the stdio server in one file on Claude Desktop's built-in Node, the key in a sensitive `user_config` field). Attach it to the GitHub release as `relay.mcpb`; the README links `releases/latest/download/relay.mcpb`.
- README install fixes from the setup hunt (2026-10-12): Claude Code `--scope user` and the missing-CLI case; the VS Code section is Copilot's agent, not the Claude Code extension; Claude Desktop leads with the bundle; a Troubleshooting section (GUI PATH, Node 16, Windows `cmd /c`, first-start time).

## 0.1.2 — 2026-10-08
- `serverInfo.version` and `/healthz` report the package version (read from package.json at build time; 0.1.1 still announced 0.1.0).

## 0.1.1 — 2026-10-08
- Install docs for Claude Code, Codex, Cursor (Add to Cursor button) and VS Code (install button); hosted endpoint marked coming soon.
- `engines.node` >= 20 (`@hono/node-server` requires it); the README said >= 18.

## 0.1.0 — 2026-10-08
- First release: 14 tools over stdio and Streamable HTTP.
