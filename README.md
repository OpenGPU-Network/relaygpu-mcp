# @relaygpu/mcp

Relay's MCP server. Your agent can find a Relay model, read its input schema, run it, poll long tasks, upload files, run workflows and search the Relay docs, all from Claude Code, Cursor, VS Code or Claude Desktop. It is built on [`@relaygpu/client`](https://www.npmjs.com/package/@relaygpu/client). The tools are generic and take the model as a string, so a model added to Relay works without a new release.

Connect to the hosted server, or run it locally:

| | How | Credential |
|---|---|---|
| **Hosted** (Streamable HTTP) | `https://mcp.relaygpu.com/mcp`, nothing to install | `X-API-Key: relay_sk_...` header, or `Authorization: Bearer <relay key or dashboard JWT>` |
| **Local** (stdio) | `npx -y @relaygpu/mcp` (Node ≥ 20) | `RELAY_API_KEY=relay_sk_...` in its environment; optional `RELAY_BASE_URL` (default `https://relaygpu.com`) |

The server never stores your key: the hosted one reads it from each request and uses it for that request only, the local one reads it from its environment.

## Install

Claude Code, Codex, Cursor and VS Code connect to the hosted server: no Node, no `npx`. Claude Desktop accepts remote servers only through OAuth, which v0 does not offer yet, so it uses the local server through a one-click bundle. Every client can also run the local server; see [Local server](#local-server-stdio).

### Claude Code

Terminal, in the CLI or the VS Code / JetBrains extension alike:

```bash
claude mcp add --transport http --scope user relay https://mcp.relaygpu.com/mcp --header "X-API-Key: relay_sk_..."
```

`--scope user` makes it available in every project; without it the server exists only in the directory you ran the command in. Check it with `/mcp` in a new session. If the terminal answers `command not found: claude`, the extension is installed but the CLI is not: install it with `curl -fsSL https://claude.ai/install.sh | bash` (or `npm install -g @anthropic-ai/claude-code`).

### Codex

Codex sends the key as a Bearer token from an environment variable, so the key stays out of `config.toml`. Set `RELAY_API_KEY` in your shell profile, then:

```bash
codex mcp add relay --url https://mcp.relaygpu.com/mcp --bearer-token-env-var RELAY_API_KEY
```

### Cursor

[![Add relay MCP server to Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](cursor://anysphere.cursor-deeplink/mcp/install?name=relay&config=eyJ1cmwiOiJodHRwczovL21jcC5yZWxheWdwdS5jb20vbWNwIiwiaGVhZGVycyI6eyJYLUFQSS1LZXkiOiJyZWxheV9za18uLi4ifX0=)

The button installs the entry below with a placeholder key; replace `relay_sk_...` in Cursor's MCP settings afterwards. By hand: `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

```json
{
  "mcpServers": {
    "relay": {
      "url": "https://mcp.relaygpu.com/mcp",
      "headers": { "X-API-Key": "relay_sk_..." }
    }
  }
}
```

### VS Code (Copilot agent mode)

This installs the server for VS Code's own agent (Copilot Chat). Using Claude Code inside VS Code? Use the [Claude Code](#claude-code) command instead: the Claude Code extension does not read VS Code's MCP config.

[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Relay_MCP-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=relay&config=%7B%22type%22%3A%22http%22%2C%22url%22%3A%22https%3A%2F%2Fmcp.relaygpu.com%2Fmcp%22%2C%22headers%22%3A%7B%22X-API-Key%22%3A%22%24%7Binput%3Arelay-key%7D%22%7D%2C%22inputs%22%3A%5B%7B%22type%22%3A%22promptString%22%2C%22id%22%3A%22relay-key%22%2C%22description%22%3A%22Relay%20API%20key%20%28relay_sk_...%29%22%2C%22password%22%3Atrue%7D%5D%7D)

VS Code asks for the key once and keeps it in its secret storage. By hand, in `.vscode/mcp.json` (one workspace) or with **MCP: Open User Configuration** (every workspace):

```json
{
  "inputs": [{ "type": "promptString", "id": "relay-key", "description": "Relay API key (relay_sk_...)", "password": true }],
  "servers": {
    "relay": {
      "type": "http",
      "url": "https://mcp.relaygpu.com/mcp",
      "headers": { "X-API-Key": "${input:relay-key}" }
    }
  }
}
```

### Claude Desktop

1. Download [`relay.mcpb`](https://github.com/OpenGPU-Network/relaygpu-mcp/releases/latest/download/relay.mcpb).
2. Double-click it. Claude Desktop opens an install dialog: click **Install**.
3. The extension installs switched off. Open Settings → Extensions → **Relay** → **Configure**.
4. Paste your Relay key and click **Save**. The key stays in Claude Desktop's secure storage.
5. Switch **Relay** on.

The bundle runs on Claude Desktop's built-in Node, so nothing else needs to be installed. `get_credits` and `get_usage` read the account, so they take a dashboard JWT or a custom-tier superkey, never a plain key; every other tool works with a plain key.

By hand instead: Settings → Developer → Edit Config opens `claude_desktop_config.json` in your default editor. Add the block below at the top level, save, then quit Claude Desktop (⌘Q) and reopen it:

```json
{
  "mcpServers": {
    "relay": {
      "command": "npx",
      "args": ["-y", "@relaygpu/mcp"],
      "env": { "RELAY_API_KEY": "relay_sk_..." }
    }
  }
}
```

### Local server (stdio)

Any client can run the server on your machine instead; it needs Node 20 or newer on the PATH the client sees (see [Troubleshooting](#troubleshooting)).

```bash
claude mcp add relay --scope user --env RELAY_API_KEY=relay_sk_... -- npx -y @relaygpu/mcp
codex mcp add relay --env RELAY_API_KEY=relay_sk_... -- npx -y @relaygpu/mcp
```

Cursor (`~/.cursor/mcp.json`) and VS Code take the same `command` / `args` / `env` entry as the Claude Desktop block above; VS Code adds `"type": "stdio"` and lists it under `"servers"`.

Ready-to-copy files are in [`examples/`](examples/).

## Troubleshooting

- **"Server disconnected", "spawn npx ENOENT" or "Executable not found: npx"** (Claude Desktop, Cursor). Apps opened from the Dock or Start menu do not load your shell profile, so a Node installed with nvm, Volta or Homebrew is not on their PATH. Use the Claude Desktop bundle, or put the full path in `"command"`: run `which npx` in a terminal and paste the result (for example `/Users/you/.nvm/versions/node/v22.22.0/bin/npx`).
- **`TypeError: Relay: no global fetch`**: the client started Node 16 or older. Install Node 20 or newer, or point `"command"` at a newer `npx`.
- **Windows**: if the client cannot start `npx`, use `"command": "cmd"` with `"args": ["/c", "npx", "-y", "@relaygpu/mcp"]`.
- **The first start takes a few seconds**: `npx` downloads the package once (about 5 s); later starts take about 1 s.

## Tools

Tools marked *keyless* work without a credential on the local server. The others are billed or account tools and need one. A hosted server with OAuth on (see [Self-hosting](#self-hosting)) takes no request without a credential, keyless tools included.

| Tool | What it does | Example |
|---|---|---|
| `search_models` *keyless* | Find models by tag and/or text | "Find a text-to-video model from Kling" → `{tag: "text-to-video", query: "kling"}` |
| `get_model` *keyless* | Route, request schema, example, pricing and status of one model | `{model: "Qwen/qwen-image"}` |
| `get_pricing` *keyless* | Public prices for one model or all of them, including the `media_storage` SKUs | `{model: "KlingTeam/v3-T2V"}` |
| `estimate_cost` *keyless* | Estimate from the public price list (not an invoice) | `{model: "KlingTeam/v3-T2V", usage: {duration_seconds: 5, quality_mode: "std"}}` |
| `run_model` | Run any model by name and wait up to 45 s | `{model: "Qwen/qwen-image", input: {prompt: "a red fox", size: "512x512"}}` |
| `check_task` *keyless* | Poll a task (waits up to 30 s) | `{task_id: "direct:…", wait_seconds: 30}` |
| `upload_file` | Host a file and get a URL for any `*_url` input | `{path: "./clip.mp4", retention: "relay1d"}` |
| `list_workflows` | List the workflow templates | "Which workflows can I run?" |
| `run_workflow` | Start a workflow run, wait up to 45 s | `{workflow_id: "script-voiceover", inputs: {messages: [{role: "user", content: "a lighthouse at dusk"}], voice: "Cherry"}}` |
| `check_workflow_run` *keyless* | Poll a run (waits up to 30 s) | `{run_id: "…", wait_seconds: 30}` |
| `cancel_workflow_run` | Cancel a run that is still in progress | `{run_id: "…"}` |
| `get_credits` | Credit balance, promos and consumption (JWT or custom-tier superkey) | "How many credits do I have left?" |
| `get_usage` | Usage analytics (JWT or custom-tier superkey) | `{period: "7d"}` |
| `search_docs` *keyless* | Search the Relay docs | `{query: "idempotency key"}` |

## Notes

- **Auth.** On the local server, and on a hosted server without OAuth, `tools/list` and the keyless tools answer without a credential. A hosted server with OAuth on answers every `/mcp` request without a credential with `401` and `WWW-Authenticate: Bearer resource_metadata="…", scope="relay"`, which is how clients start the "Connect Relay" sign-in; `X-API-Key` and `Authorization: Bearer <relay key or dashboard JWT>` keep working there. A billed tool called without one returns a `MISSING_CREDENTIALS` tool error that names what to set: the `X-API-Key` header (hosted) or `RELAY_API_KEY` (stdio). Errors from Relay come back as tool errors that include the error class, `code`, `requestId` and the server's detail. Your key never appears in a tool result or a log line.
- **Long tasks.** `run_model` waits up to 45 s (`wait_seconds`, 0–45). If the task is still running after that, it returns the `task_id` and the line "Do not resubmit: call check_task with this task_id". Every submit carries an `Idempotency-Key`, so a retry does not bill twice. Pass your own `idempotency_key` if your agent might send the same submit again.
- **Expiry.** Each result link comes with its expiry: "expires 1 h after completion unless store_output was set". To keep results longer, pass `store_output` with a `media_storage` SKU from `get_pricing` (for example `relay7d`). That SKU adds a per-file fee.
- **Re-hosting.** Some routes return images only as inline base64 (for example gpt-image and Flux). The server uploads those images through `/v2/files`, at the `store_output` retention or `relay1h` by default (free within the daily quota), and returns a URL and a `file_id` instead of the base64. Image content blocks are opt-in: pass `inline_images: true`, which applies to images of 1 MB or less.
- **Uploads.** On stdio, `upload_file` streams a local `path` of up to 100 MB. The hosted server cannot read your disk. On hosted, pass `base64` (up to 4 MB) or a public `url` instead. Retention defaults to `relay1h`.

## Self-hosting

```bash
docker build -t relaygpu-mcp .
docker run -p 2300:2300 -e PORT=2300 -e RELAY_BASE_URL=https://relaygpu.com relaygpu-mcp
```

The server listens on `PORT` (default 2300) and calls Relay at `RELAY_BASE_URL`. Endpoints:

- `POST /mcp`: Streamable HTTP, stateless.
- `GET /healthz`: returns `{status, version}`.
- `GET /metrics`: Prometheus text with `mcp_tool_calls_total{tool,outcome}` and `mcp_tool_seconds{tool}`.
- `GET /.well-known/mcp/server-card.json`: the server and its tools.
- `GET /.well-known/oauth-protected-resource` (and `…/mcp`): the RFC 9728 protected-resource metadata, only with OAuth on.

### OAuth ("Connect Relay")

OAuth is on when both `OAUTH_ISSUER` and `MCP_RESOURCE_URL` are set; with either unset the server behaves as above (no metadata route, keyless tools answer without a credential). All three variables belong to the **MCP app** and are read once at start:

| Variable | Value | Notes |
|---|---|---|
| `OAUTH_ISSUER` | `https://relaygpu.com` (prod), `http://10.0.34.27:1300` (staging, VPN) | Relay's authorization server; the JWKS is read from `{issuer}/v2/oauth/jwks`, the exchange posts to `{issuer}/v2/oauth/token` |
| `MCP_RESOURCE_URL` | `https://mcp.relaygpu.com/mcp` (prod), `http://relay-mcp-staging.internal.opengpu.network/mcp` (staging, VPN) | This server's public `/mcp` URL: the access token's `aud` must equal it, and the metadata URL is its origin + `/.well-known/oauth-protected-resource` |
| `OAUTH_MCP_CLIENT_SECRET` | secret | The `relay-mcp` client's secret: the same value as **Relay's** `OAUTH_MCP_CLIENT_SECRET` in the same environment. Without it every exchange fails (`503`) |

A Bearer value that is a JWT issued by `OAUTH_ISSUER` is an access token: the server verifies it (ES256 against the issuer's JWKS, `aud`, `exp` with 60 s skew), exchanges it at Relay for a 5-minute Relay credential and keeps that credential in memory per token hash until 30 s before it expires. A bad, expired or revoked token gets `401` with `WWW-Authenticate: Bearer error="invalid_token", …`; an authorization server that cannot be reached gets `503`. Tokens, credentials and the secret are never logged.

Logs are JSON lines on stderr, `WARNING` and above by default (`LOG_LEVEL`). Without Docker, run `npm ci && npm run build && node dist/http.js`.

## License

MIT
