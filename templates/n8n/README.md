# n8n templates

Two importable n8n workflows that call Relay through the hosted MCP server.

| File | What it does |
|---|---|
| `relay-run-model.json` | Runs any Relay model with the input you set, then polls the task until it completes or fails. |
| `relay-image-to-video.json` | FLUX-2-pro image, then Wan2.5-I2V animation, polled until done. |

## Import

1. In n8n, open a new workflow, then **...** → **Import from File...**.
2. Pick a `.json` file from this folder.
3. Select the credential below on each **Relay** node.

## Credential

Create a **Header Auth** credential:

- Name: `Relay API key`
- Header name: `X-API-Key`
- Header value: your Relay API key (`relay_sk_...`)

The Relay nodes use n8n's **MCP Client** node, endpoint
`https://mcp.relaygpu.com/mcp`, Server Transport HTTP Streamable. Needs n8n 1.122.0 or later.

Full guide: https://docs.relaygpu.com/sdk/n8n

These files are the published copies; the hosted MCP server itself is unchanged by them.
