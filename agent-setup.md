# Connect this agent to Relay

You are an AI coding agent. Follow the section for the client you are running in. Do not install anything beyond what the section names. Never ask the user to paste an API key into the chat; the hosted server signs in with the user's Relay account (Connect Relay).

Relay's MCP server: `https://mcp.relaygpu.com/mcp` (Streamable HTTP, OAuth sign-in, 14 tools: find a model, read its schema, run it, poll it, upload a file, estimate cost, search the docs).

## Claude Code (verified)

```
claude mcp add --transport http relay https://mcp.relaygpu.com/mcp
```

Then tell the user: run `/mcp`, choose `relay`, choose Authenticate; the browser opens Relay's sign-in; click Allow. Afterwards run `/mcp` again to confirm `relay` shows Connected.

## Claude Desktop (verified)

Two roads; pick the first unless the user asks for a local server:

1. Custom connector: Settings → Connectors → Add custom connector → URL `https://mcp.relaygpu.com/mcp` → Connect → Allow in the browser.
2. Bundle: download `https://github.com/OpenGPU-Network/relaygpu-mcp/releases/latest/download/relay.mcpb`, open it with Claude Desktop, paste a Relay API key when asked (this road uses a key, not sign-in).

## claude.ai and ChatGPT (human steps, no commands)

claude.ai: Customize → Connectors → Add custom connector → `https://mcp.relaygpu.com/mcp` → Connect → Allow.
ChatGPT: Settings → Connectors → Create → MCP server URL `https://mcp.relaygpu.com/mcp` → OAuth → Allow.

## Codex CLI

```
codex mcp add relay --url https://mcp.relaygpu.com/mcp
codex mcp login relay
```

## Cursor

Write `.cursor/mcp.json` in the project (or the global MCP settings):

```json
{ "mcpServers": { "relay": { "url": "https://mcp.relaygpu.com/mcp" } } }
```

Then tell the user to open Cursor Settings → MCP → relay → sign in.

## VS Code (Copilot agent mode)

Write `.vscode/mcp.json`:

```json
{ "servers": { "relay": { "type": "http", "url": "https://mcp.relaygpu.com/mcp" } } }
```

## Windsurf

Add to `~/.codeium/windsurf/mcp_config.json` under `mcpServers`: `"relay": { "serverUrl": "https://mcp.relaygpu.com/mcp" }`.

## Gemini CLI

```
gemini mcp add --transport http relay https://mcp.relaygpu.com/mcp
```

## Any other MCP client

Add a remote (Streamable HTTP) server at `https://mcp.relaygpu.com/mcp`; the client's OAuth flow signs the user in. If the client cannot do OAuth, run the local server instead with a Relay API key in its environment:

```
RELAY_API_KEY=relay_sk_... npx -y @relaygpu/mcp
```

(Create the key at https://dashboard.relaygpu.com → API Keys. The key never goes into chat.)

## Verify

After sign-in, call the `get_model` tool with `google/gemini-nano-banana-2.1`. A schema comes back: connected. A 401: the sign-in did not complete; repeat the client's login step. Then tell the user what you can do: find a model, run it, upload a file, check cost.

## Local files

The hosted server cannot read the user's disk. To send a local file: call `upload_file` with `slot: true`, run the returned `curl` line in the shell (Claude Code, Codex, Cursor, VS Code: you can run it yourself), and pass the printed link to `run_model`. In claude.ai, Claude Desktop (connector) and ChatGPT, ask the user to open the link in a browser, pick the file and paste the link back.
