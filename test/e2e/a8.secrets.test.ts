// A8 (F8, N2): the budget-zero key's 402 surfaces as a tool error with KEY_BUDGET_EXHAUSTED + a requestId line, and
// the key string appears in NO captured stream: hosted result texts + hosted server stderr/stdout (child, LOG_LEVEL=debug),
// stdio stdout + stderr bytes (raw driver, LOG_LEVEL=debug). Asserts are boolean so a failure can never print the key.
// Not billed: the key is refused at auth time.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BASE_URL, BUDGET_ZERO_KEY, HAS_BASE, QWEN, hostedChild, mcpHttp, rawStdio, textOf } from "./harness.js";

const leaks = (s: string) => s.includes(BUDGET_ZERO_KEY);

describe.skipIf(!HAS_BASE || !BUDGET_ZERO_KEY)("A8 budget-zero key", () => {
  let server: Awaited<ReturnType<typeof hostedChild>>;

  beforeAll(async () => {
    server = await hostedChild({ RELAY_BASE_URL: BASE_URL, LOG_LEVEL: "debug" });
  });
  afterAll(async () => {
    await server?.close();
  });

  it("A8 hosted: KEY_BUDGET_EXHAUSTED with requestId, key absent from results and server logs", async () => {
    const mcp = await mcpHttp(server.url, { "X-API-Key": BUDGET_ZERO_KEY });
    let text = "";
    let isError: boolean | undefined;
    try {
      const r = await mcp.call("run_model", QWEN);
      isError = r.isError;
      text = textOf(r);
    } finally {
      await mcp.close();
    }
    expect(isError).toBe(true);
    expect(text.includes("KEY_BUDGET_EXHAUSTED")).toBe(true);
    expect(/requestId:\s*\S+/.test(text)).toBe(true);
    expect(leaks(text)).toBe(false);
    expect(leaks(server.stderr())).toBe(false);
    expect(leaks(server.stdout())).toBe(false);
  });

  it("A8 stdio: KEY_BUDGET_EXHAUSTED with requestId, key absent from stdout and stderr", async () => {
    const run = await rawStdio({ RELAY_API_KEY: BUDGET_ZERO_KEY, RELAY_BASE_URL: BASE_URL, LOG_LEVEL: "debug" }, [
      { method: "tools/call", params: { name: "run_model", arguments: QWEN } },
    ]);
    const result = run.responses.get(2)?.result as { isError?: boolean; content?: { type: string; text?: string }[] } | undefined;
    const text = (result?.content ?? []).map((c) => c.text ?? "").join("\n");
    expect(result?.isError).toBe(true);
    expect(text.includes("KEY_BUDGET_EXHAUSTED")).toBe(true);
    expect(/requestId:\s*\S+/.test(text)).toBe(true);
    expect(leaks(run.stdout.toString("utf8"))).toBe(false);
    expect(leaks(run.stderr)).toBe(false);
  });
});
