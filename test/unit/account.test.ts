import { describe, expect, it } from "vitest";
import { accountTools } from "../../src/tools/account.js";
import { apiError, connect, mockFetch, textOf } from "../helpers/harness.js";

describe("account tools", () => {
  it("exports get_credits, get_usage; both descriptions name who may call them", () => {
    expect(accountTools.map((t) => t.name)).toEqual(["get_credits", "get_usage"]);
    for (const t of accountTools) {
      expect(t.description).toContain("Needs a dashboard JWT or a custom-tier superkey; a plain inference key gets PERMISSION_DENIED (403).");
    }
  });

  it("get_credits: GET /v2/customer/credits with the caller's key", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/customer/credits", reply: { json: { balance: 12.5, promo_credits: [] } } }]);
    const s = await connect({ fetch: m.fetch, tools: accountTools });
    const r = await s.call("get_credits");
    expect(r.isError).toBeFalsy();
    expect(m.calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /v2/customer/credits"]);
    expect(m.calls[0].headers.get("x-api-key")).toBe("relay_sk_unit_test_key");
    expect(textOf(r)).toContain("12.5");
    await s.close();
  });

  it("get_usage: GET /v2/customer/usage, params passed through; JWT goes as Bearer", async () => {
    const m = mockFetch([{ method: "GET", path: "/v2/customer/usage", reply: { json: { keys: [], total_cost_usd: 0 } } }]);
    const s = await connect({ fetch: m.fetch, tools: accountTools, credential: { jwt: "a.b.c" } });
    const r = await s.call("get_usage", { period: "7d" });
    expect(r.isError).toBeFalsy();
    expect(m.calls[0].path).toBe("/v2/customer/usage");
    expect(m.calls[0].query.get("period")).toBe("7d");
    expect(m.calls[0].query.has("from")).toBe(false);
    expect(m.calls[0].headers.get("authorization")).toBe("Bearer a.b.c");
    await s.close();
  });

  it("a plain inference key: the server's 403 surfaces as PermissionDeniedError", async () => {
    const m = mockFetch([
      { method: "GET", path: "/v2/customer/credits", reply: apiError(403, "PERMISSION_DENIED", "This route needs a dashboard JWT or a superkey") },
      { method: "GET", path: "/v2/customer/usage", reply: apiError(403, "PERMISSION_DENIED", "This route needs a dashboard JWT or a superkey") },
    ]);
    const s = await connect({ fetch: m.fetch, tools: accountTools });
    for (const name of ["get_credits", "get_usage"]) {
      const r = await s.call(name);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("PermissionDeniedError");
      expect(textOf(r)).toContain("code: PERMISSION_DENIED");
    }
    await s.close();
  });

  it("no credential: MISSING_CREDENTIALS, zero requests", async () => {
    const m = mockFetch([]);
    const s = await connect({ fetch: m.fetch, tools: accountTools, credential: null });
    const r = await s.call("get_credits");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("MISSING_CREDENTIALS");
    expect(m.calls).toHaveLength(0);
    await s.close();
  });
});
