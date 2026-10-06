// Prometheus text for GET /metrics: mcp_tool_calls_total{tool,outcome} and mcp_tool_seconds{tool} (summary: sum + count).
const calls = new Map<string, number>();
const seconds = new Map<string, { sum: number; count: number }>();

export function recordToolCall(tool: string, outcome: "ok" | "error", elapsedS: number): void {
  const key = `${tool}\u0000${outcome}`;
  calls.set(key, (calls.get(key) ?? 0) + 1);
  const s = seconds.get(tool) ?? { sum: 0, count: 0 };
  s.sum += elapsedS;
  s.count += 1;
  seconds.set(tool, s);
}

const label = (v: string) => v.replace(/[\\"\n]/g, (c) => (c === "\n" ? "\\n" : "\\" + c));

export function renderMetrics(): string {
  const out = [
    "# HELP mcp_tool_calls_total MCP tool calls by tool and outcome.",
    "# TYPE mcp_tool_calls_total counter",
  ];
  for (const [key, n] of calls) {
    const [tool, outcome] = key.split("\u0000");
    out.push(`mcp_tool_calls_total{tool="${label(tool)}",outcome="${outcome}"} ${n}`);
  }
  out.push("# HELP mcp_tool_seconds MCP tool call duration in seconds.", "# TYPE mcp_tool_seconds summary");
  for (const [tool, s] of seconds) {
    out.push(`mcp_tool_seconds_sum{tool="${label(tool)}"} ${s.sum}`, `mcp_tool_seconds_count{tool="${label(tool)}"} ${s.count}`);
  }
  return out.join("\n") + "\n";
}
