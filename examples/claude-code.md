# Claude Code

Local (stdio, key in the server's environment):

```bash
claude mcp add relay --scope user --env RELAY_API_KEY=relay_sk_... -- npx -y @relaygpu/mcp
```

Hosted (Streamable HTTP, key in a header; once `mcp.relaygpu.com` is live):

```bash
claude mcp add --transport http --scope user relay https://mcp.relaygpu.com/mcp --header "X-API-Key: relay_sk_..."
```

`--scope user` makes it available in every project; without it the server exists only in the current directory. Check it with `claude mcp list`, or with `/mcp` inside a session.
