// get_credits / get_usage: account reads. The server decides who may read them (JWT or custom-tier superkey);
// the SDK surfaces its 403 as PermissionDeniedError and the wrapper prints it.
import { z } from "zod";
import { defineTool, jsonResult, type ToolDef } from "../context.js";

const AUTH_NOTE = "Needs a dashboard JWT or a custom-tier superkey; a plain inference key gets PERMISSION_DENIED (403).";

const get_credits = defineTool({
  name: "get_credits",
  title: "Get credit balance",
  description: `Read the account's credit balance, active promo credits and consumption. ${AUTH_NOTE}`,
  inputSchema: {},
  annotations: { readOnlyHint: true, openWorldHint: true },
  billed: true,
  async handler(_args, ctx) {
    return jsonResult(await ctx.client().account.credits());
  },
});

const get_usage = defineTool({
  name: "get_usage",
  title: "Get usage",
  description:
    `Read the account's usage and spend per API key. Pass period (e.g. 7d) for a by-date breakdown, or from + to. ${AUTH_NOTE}`,
  inputSchema: {
    period: z.string().optional().describe("Time period shorthand, e.g. `7d` or `30d` (max 30 days); adds a by-date breakdown."),
    from: z.string().optional().describe("Start date `YYYY-MM-DD`; use together with `to`."),
    to: z.string().optional().describe("End date `YYYY-MM-DD`; use together with `from`."),
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
  billed: true,
  async handler({ period, from, to }, ctx) {
    return jsonResult(await ctx.client().account.usage({ period, from, to }));
  },
});

export const accountTools: ToolDef[] = [get_credits, get_usage];
