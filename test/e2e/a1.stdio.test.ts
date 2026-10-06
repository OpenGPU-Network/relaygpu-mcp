// A1 (F1, N3): stdio from the packed tarball answers initialize + tools/list (14); stdout carries only frames.
// Keyless: no credential is passed. Gated on RELAY_BASE_URL like the whole suite (it pins the bin off production).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_URL, HAS_BASE, ROOT, TOOL_NAMES, mcpStdio, rawStdio } from "./harness.js";

describe.skipIf(!HAS_BASE)("A1 stdio", () => {
  const dir = mkdtempSync(join(tmpdir(), "relaygpu-mcp-a1-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  let tarball = "";
  let packedFiles: string[] = [];
  const pack = () => {
    if (tarball) return tarball;
    // dist/ is fresh from `npm run build` (test:e2e); --ignore-scripts skips the prepack rebuild.
    const out = execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], { cwd: ROOT, encoding: "utf8" });
    const [info] = JSON.parse(out) as { filename: string; files: { path: string }[] }[];
    tarball = join(dir, info.filename);
    packedFiles = info.files.map((f) => f.path);
    return tarball;
  };

  it("A10 npm pack carries dist/, README.md, LICENSE (and package.json) only", () => {
    pack();
    expect(packedFiles.some((p) => p.startsWith("dist/"))).toBe(true);
    expect(packedFiles).toContain("README.md");
    expect(packedFiles).toContain("LICENSE");
    expect(packedFiles.filter((p) => !p.startsWith("dist/") && !["README.md", "LICENSE", "package.json"].includes(p))).toEqual([]);
  });

  it("A1 npx -y --package <tarball> relaygpu-mcp answers initialize and tools/list (14 tools)", async () => {
    const mcp = await mcpStdio({ RELAY_BASE_URL: BASE_URL }, "npx", ["-y", "--package", pack(), "relaygpu-mcp"], dir);
    try {
      expect(mcp.client.getServerVersion()?.name).toBe("relaygpu");
      const { tools } = await mcp.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    } finally {
      await mcp.close();
    }
  });

  it("A1 stdout carries only JSON-RPC frames while a tool call logs to stderr", async () => {
    const run = await rawStdio({ RELAY_BASE_URL: BASE_URL, LOG_LEVEL: "info" }, [
      { method: "tools/list", params: {} },
      { method: "tools/call", params: { name: "search_docs", arguments: { query: "idempotency key" } } },
    ]);
    const lines = run.stdout.toString("utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const line of lines) {
      const msg = JSON.parse(line) as { jsonrpc?: string };
      expect(msg.jsonrpc).toBe("2.0");
    }
    expect(run.stdout.toString("utf8").endsWith("\n")).toBe(true);
    const tools = (run.responses.get(2)?.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(TOOL_NAMES);
    expect((run.responses.get(3)?.result as { isError?: boolean }).isError).toBeFalsy();
    const logs = run.stderr.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { msg?: string; tool?: string });
    expect(logs.some((l) => l.msg === "tool_call" && l.tool === "search_docs")).toBe(true);
  });
});
