import type { ToolDef } from "../context.js";
import { catalogTools } from "./catalog.js";
import { runTools } from "./run.js";
import { filesTools } from "./files.js";
import { workflowTools } from "./workflows.js";
import { accountTools } from "./account.js";
import { docsTools } from "./docs.js";

/** Every tool, in tools/list order. PRD F3: exactly 14. */
export const ALL_TOOLS: ToolDef[] = [...catalogTools, ...runTools, ...filesTools, ...workflowTools, ...accountTools, ...docsTools];
