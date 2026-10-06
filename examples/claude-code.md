# Claude Code

Hosted (Streamable HTTP, key in a header):

```bash
claude mcp add --transport http relay https://mcp.relaygpu.com/mcp --header "X-API-Key: relay_sk_..."
```

Local (stdio, key in the server's environment):

```bash
claude mcp add relay --env RELAY_API_KEY=relay_sk_... -- npx -y @relaygpu/mcp
```

Add `--scope user` to use it in every project. Check it with `claude mcp list`, or with `/mcp` inside a session.
