# @relaygpu/mcp

Relay's MCP server. Your agent can find a Relay model, read its input schema, run it, poll long tasks, upload files, run workflows and search the Relay docs, all from Claude Code, Cursor, VS Code or Claude Desktop. It is built on [`@relaygpu/client`](https://www.npmjs.com/package/@relaygpu/client). The tools are generic and take the model as a string, so a model added to Relay works without a new release.

There are two ways to connect, both running the same server:

| | How | Credential |
|---|---|---|
| **Hosted** (Streamable HTTP) | `https://mcp.relaygpu.com/mcp` | `X-API-Key: relay_sk_...` header, or `Authorization: Bearer <relay key or dashboard JWT>` |
| **Local** (stdio) | `npx -y @relaygpu/mcp` (Node ≥ 18) | `RELAY_API_KEY=relay_sk_...` in its environment; optional `RELAY_BASE_URL` (default `https://relaygpu.com`) |

The server never stores your key. The hosted server reads it from each request and uses it for that request only.

## Install

### Claude Code

```bash
# Hosted
claude mcp add --transport http relay https://mcp.relaygpu.com/mcp --header "X-API-Key: relay_sk_..."

# Local (stdio)
claude mcp add relay --env RELAY_API_KEY=relay_sk_... -- npx -y @relaygpu/mcp
```

### Cursor

Edit `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project).

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

Local: `"relay": { "command": "npx", "args": ["-y", "@relaygpu/mcp"], "env": { "RELAY_API_KEY": "relay_sk_..." } }`.

### VS Code

Edit `.vscode/mcp.json`. VS Code asks for the key once and keeps it in its secret storage:

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

Local: `"relay": { "type": "stdio", "command": "npx", "args": ["-y", "@relaygpu/mcp"], "env": { "RELAY_API_KEY": "${input:relay-key}" } }`.

### Claude Desktop (stdio only)

Claude Desktop, claude.ai connectors and ChatGPT accept remote MCP servers only through OAuth, and v0 does not offer OAuth, so these clients use the local server. Add the following to `claude_desktop_config.json` (Settings → Developer → Edit Config), then restart Claude Desktop:

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

Ready-to-copy files are in [`examples/`](examples/).

## Tools

Tools marked *keyless* work without a credential. The others are billed or account tools and need one.

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

- **Auth.** `tools/list` and the keyless tools answer without a credential. A billed tool called without one returns a `MISSING_CREDENTIALS` tool error that names what to set: the `X-API-Key` header (hosted) or `RELAY_API_KEY` (stdio). Errors from Relay come back as tool errors that include the error class, `code`, `requestId` and the server's detail. Your key never appears in a tool result or a log line.
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

Logs are JSON lines on stderr, `WARNING` and above by default (`LOG_LEVEL`). Without Docker, run `npm ci && npm run build && node dist/http.js`.

## License

MIT
