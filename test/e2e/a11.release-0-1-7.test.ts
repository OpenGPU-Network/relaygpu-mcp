// 0.1.7 against staging (PRD mcp_0_1_7 A1, A2): a GPT Image 2 quality: high edit of a slot-uploaded PNG is submitted
// async: true, so it answers the result or a task_id within wait_seconds, never a 524; check_task completes it, and the
// account's gpt-image-2 request count grows by exactly one. The same idempotency_key replays the task (no new bill); a
// changed prompt under that key is 422 IDEMPOTENCY_KEY_REUSED. Billed: one GPT Image 2 edit; the slot upload is free.
// Credentials come from the SDK test account's .env (relaygpu-node), read here and never printed.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Relay } from "@relaygpu/client";
import { startHostedServer } from "../../src/hosted.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpHttp, solidPng, textOf, type McpHandle } from "./harness.js";
import { jsonOf } from "../fixtures/relay.js";

const NODE_ENV_FILE = "/Users/windirq/Desktop/relaygpu-node/.env";

/** KEY=VALUE pairs of the SDK test account's .env (values stay in memory, never logged). */
function readEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const env = readEnv(NODE_ENV_FILE);
const BASE = env.RELAY_BASE_URL ?? "";
const KEY = env.RELAY_API_KEY ?? "";
if (BASE && /(^|\.)(relaygpu\.com|relay\.opengpu\.network)$/i.test(new URL(BASE).hostname)) {
  throw new Error("e2e refused: the SDK test account's RELAY_BASE_URL points at production");
}

const MODEL = "openai/gpt-image-2";
const EDGE_CUT = /\b524\b|Proxy Read Timeout/;

/** The account's lifetime request count for the model, summed over its keys (usage counts completed, billed requests). */
async function billedRequests(relay: Relay): Promise<number> {
  const usage = (await relay.account.usage({})) as unknown as { keys: { analytics?: { lifetime?: Record<string, Record<string, Record<string, { requests?: number }>>> } }[] };
  let n = 0;
  for (const k of usage.keys) for (const sources of Object.values(k.analytics?.lifetime ?? {})) for (const models of Object.values(sources)) n += models[MODEL]?.requests ?? 0;
  return n;
}

describe.skipIf(!BASE || !KEY)("0.1.7 A1/A2 async-always run_model (hosted, X-API-Key stand-in for OAuth)", () => {
  const dir = mkdtempSync(join(tmpdir(), "relaygpu-mcp-017-"));
  const pngPath = join(dir, "red.png");
  const relay = new Relay({ apiKey: KEY, baseUrl: BASE });
  const idem = `e2e-017-${randomUUID()}`;
  const uploaded: string[] = [];
  let hosted: Awaited<ReturnType<typeof startHostedServer>>;
  let mcp: McpHandle;
  let link = "";
  let taskId = "";
  let before = 0;

  beforeAll(async () => {
    writeFileSync(pngPath, solidPng(256, [220, 30, 30]));
    hosted = await startHostedServer({ port: 0, baseUrl: BASE });
    mcp = await mcpHttp(hosted.url, { "X-API-Key": KEY });
    before = await billedRequests(relay);
  });
  afterAll(async () => {
    await mcp?.close();
    await hosted?.close();
    for (const id of uploaded) await relay.files.delete(id).catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("A5 slot answers open_url = put_url; the curl road hosts the PNG", async () => {
    const slot = await mcp.call("upload_file", { slot: true, filename: "red.png" });
    expect(slot.isError, textOf(slot)).toBeFalsy();
    const s = jsonOf(slot);
    expect(s.open_url).toBe(s.put_url);
    const argv = (s.curl as string).split(/\s+/).map((a) => (a === "<file>" ? pngPath : a));
    const file = JSON.parse(execFileSync("curl", ["-sS", "--fail-with-body", ...argv.slice(1)], { encoding: "utf8", timeout: 60_000 })) as { file_id: string; url: string };
    uploaded.push(file.file_id);
    expect(file.url).toMatch(/^https:\/\//);
    link = file.url;
  });

  it("A1 gpt-image-2 quality: high edit, default wait_seconds → the result or a task_id with next check_task, never a 524", async () => {
    const started = Date.now();
    const r = await mcp.call("run_model", {
      model: MODEL,
      input: { prompt: "make the square blue", image: link, size: "1024x1024", quality: "high" },
      idempotency_key: idem,
    });
    const seconds = (Date.now() - started) / 1000;
    expect(textOf(r)).not.toMatch(EDGE_CUT);
    expect(r.isError, textOf(r)).toBeFalsy();
    const e = jsonOf(r);
    expect(e.task_id).toMatch(/^direct:/);
    taskId = e.task_id;
    if (e.status !== "completed") expect(e.next).toEqual({ tool: "check_task", args: { task_id: taskId } });
    expect(seconds).toBeLessThan(90); // 45 s wait + the submit, nowhere near the edge's 120 s
    console.log(`A1 run_model answered status=${e.status} after ${seconds.toFixed(1)} s`);
  });

  it("A2 the same submit and key replays the task (replayed: true, same task_id)", async () => {
    const r = await mcp.call("run_model", {
      model: MODEL,
      input: { prompt: "make the square blue", image: link, size: "1024x1024", quality: "high" },
      idempotency_key: idem,
      wait_seconds: 0,
    });
    expect(r.isError, textOf(r)).toBeFalsy();
    expect(jsonOf(r)).toMatchObject({ task_id: taskId, replayed: true });
  });

  it("A2 the same key with a changed prompt → 422 IDEMPOTENCY_KEY_REUSED", async () => {
    const r = await mcp.call("run_model", {
      model: MODEL,
      input: { prompt: "make the square green", image: link, size: "1024x1024", quality: "high" },
      idempotency_key: idem,
      wait_seconds: 0,
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("IDEMPOTENCY_KEY_REUSED");
    expect(textOf(r)).toContain("status: 422");
  });

  it("A1 check_task completes it; the account's gpt-image-2 requests grow by exactly one", async () => {
    let status = "";
    let last;
    for (let i = 0; i < 12 && status !== "completed"; i++) {
      last = await mcp.call("check_task", { task_id: taskId, wait_seconds: 30 });
      expect(textOf(last)).not.toMatch(EDGE_CUT);
      expect(last.isError, textOf(last)).toBeFalsy();
      status = jsonOf(last).status;
    }
    expect(status).toBe("completed");
    const out = jsonOf(last!).output as { urls?: string[]; data?: unknown[] };
    expect((out.urls ?? out.data ?? []).length).toBeGreaterThan(0);

    let delta = 0;
    for (let i = 0; i < 20; i++) {
      delta = (await billedRequests(relay)) - before;
      if (delta >= 1) break;
      await new Promise((res) => setTimeout(res, 3_000));
    }
    await new Promise((res) => setTimeout(res, 5_000)); // a late second bill would land here
    delta = (await billedRequests(relay)) - before;
    console.log(`A1 gpt-image-2 billed requests: before=${before} delta=${delta}`);
    expect(delta).toBe(1);
  });
});
