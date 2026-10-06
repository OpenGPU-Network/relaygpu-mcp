// Prometheus text for GET /metrics: mcp_tool_calls_total{tool,outcome} and mcp_tool_seconds{tool} (summary: sum + count).
const tools = new Map<string, { ok: number; error: number; sum: number; count: number }>();

export function recordToolCall(tool: string, outcome: "ok" | "error", elapsedS: number): void {
  let t = tools.get(tool);
  if (!t) tools.set(tool, (t = { ok: 0, error: 0, sum: 0, count: 0 }));
  t[outcome] += 1;
  t.sum += elapsedS;
  t.count += 1;
}

const label = (v: string) => v.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : "\\" + c));

export function renderMetrics(): string {
  const out = ["# HELP mcp_tool_calls_total MCP tool calls by tool and outcome.", "# TYPE mcp_tool_calls_total counter"];
  for (const [tool, t] of tools) {
    for (const outcome of ["ok", "error"] as const) {
      if (t[outcome]) out.push(`mcp_tool_calls_total{tool="${label(tool)}",outcome="${outcome}"} ${t[outcome]}`);
    }
  }
  out.push("# HELP mcp_tool_seconds MCP tool call duration in seconds.", "# TYPE mcp_tool_seconds summary");
  for (const [tool, t] of tools) {
    out.push(`mcp_tool_seconds_sum{tool="${label(tool)}"} ${t.sum}`, `mcp_tool_seconds_count{tool="${label(tool)}"} ${t.count}`);
  }
  return out.join("\n") + "\n";
}
