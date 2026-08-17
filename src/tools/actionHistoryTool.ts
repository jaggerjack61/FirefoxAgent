/**
 * Action history tool: lets the agent inspect what it has done so far.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";

export interface ActionHistory {
  entries: { tool: string; label: string; status: string; at: number }[];
}

export const getActionHistoryTool = defineTool({
  name: "get_action_history",
  description: "List the browser actions executed so far in this conversation (times, tools, status).",
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional().default(30) }),
  async execute(input, ctx) {
    const limit = input.limit ?? 30;
    const entries = ctx.actionHistory?.() ?? [];
    return { entries: entries.slice(-limit) };
  },
});
