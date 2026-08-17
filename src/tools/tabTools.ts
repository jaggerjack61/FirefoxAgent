/**
 * Tab tools: list, switch, open, close, reload, duplicate, back/forward.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";

const tabIdSchema = z.object({ tabId: z.number().int().positive() });
const optionalTabIdSchema = z.object({ tabId: z.number().int().positive().optional() });

async function resolveTabId(ctx: { gateway: { getActiveTab(): Promise<{ id: number } | null> } }, tabId?: number): Promise<number> {
  if (tabId !== undefined) return tabId;
  const active = await ctx.gateway.getActiveTab();
  if (!active) throw new Error("No active tab found");
  return active.id;
}

export const listTabsTool = defineTool({
  name: "list_tabs",
  description:
    "List all open browser tabs with id, title, url, active flag, window id, document status, and API-idle readiness. Use this only for an explicit multi-tab request.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const tabs = await ctx.gateway.listTabs();
    return { count: tabs.length, tabs };
  },
});

export const getActiveTabTool = defineTool({
  name: "get_active_tab",
  description: "Get the currently active tab (id, title, url).",
  exposeToModel: false,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const tab = await ctx.gateway.getActiveTab();
    if (!tab) return { error: "No active tab found" };
    return tab;
  },
});

export const getTabTool = defineTool({
  name: "get_tab",
  description: "Get metadata (title, url) for a specific tab by id.",
  exposeToModel: false,
  inputSchema: tabIdSchema,
  async execute(input, ctx) {
    const tab = await ctx.gateway.getTab(input.tabId);
    if (!tab) throw new Error(`Tab ${input.tabId} does not exist`);
    return tab;
  },
});

export const switchTabTool = defineTool({
  name: "switch_tab",
  description: "Switch the browser to another tab (makes it the active tab).",
  inputSchema: tabIdSchema,
  async execute(input, ctx) {
    await ctx.gateway.switchTab(input.tabId);
    const tab = await ctx.gateway.getTab(input.tabId);
    return { switched: true, tabId: input.tabId, tab: tab ?? null };
  },
});

export const openTabTool = defineTool({
  name: "open_tab",
  description: "Open a URL in a new tab only when the user explicitly asks for a new/other tab. Use background=true to preserve the current tab focus.",
  inputSchema: z.object({
    url: z.string().url().describe("The URL to open"),
    background: z.boolean().optional().describe("Open in the background (default false)"),
  }),
  async execute(input, ctx) {
    const tab = await ctx.gateway.openTab(input.url, { background: input.background ?? false });
    return { opened: true, tabId: tab.id, title: tab.title, url: tab.url, loaded: tab.ready ?? tab.status !== "loading" };
  },
});

export const closeTabTool = defineTool({
  name: "close_tab",
  description: "Close one browser tab by id. Use close_tabs for an explicit multi-tab close request.",
  inputSchema: optionalTabIdSchema,
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await ctx.gateway.closeTab(tabId);
    return { closed: true, tabId };
  },
});

export const closeTabsTool = defineTool({
  name: "close_tabs",
  description: "Close several explicitly identified tabs in one operation. Closing three or more requires confirmation.",
  inputSchema: z.object({
    tabIds: z.array(z.number().int().positive()).min(1).max(50)
      .refine((ids) => new Set(ids).size === ids.length, "Tab ids must be unique"),
  }),
  async execute(input, ctx) {
    await Promise.all(input.tabIds.map((tabId) => ctx.gateway.closeTab(tabId)));
    return { closed: true, count: input.tabIds.length, tabIds: input.tabIds };
  },
});

export const reloadTabTool = defineTool({
  name: "reload_tab",
  description: "Reload a tab only when the user explicitly requests a reload or a prior tool says the page is stale, unavailable, or still loading. Never reload merely to begin inspecting a page.",
  inputSchema: optionalTabIdSchema,
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await ctx.gateway.reloadTab(tabId);
    const tab = await ctx.gateway.getTab(tabId);
    return { reloaded: true, tabId, loaded: tab ? (tab.ready ?? tab.status !== "loading") : false };
  },
});

export const duplicateTabTool = defineTool({
  name: "duplicate_tab",
  description: "Duplicate a tab, creating a copy with the same URL.",
  inputSchema: optionalTabIdSchema,
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const tab = await ctx.gateway.duplicateTab(tabId);
    return { duplicated: true, newTabId: tab.id, url: tab.url, loaded: tab.ready ?? tab.status !== "loading" };
  },
});

export const goBackTool = defineTool({
  name: "go_back",
  description: "Navigate the given tab back one step in history.",
  inputSchema: optionalTabIdSchema,
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await ctx.gateway.goBack(tabId);
    const tab = await ctx.gateway.getTab(tabId);
    return { wentBack: true, tabId, loaded: tab ? (tab.ready ?? tab.status !== "loading") : false };
  },
});

export const goForwardTool = defineTool({
  name: "go_forward",
  description: "Navigate the given tab forward one step in history.",
  inputSchema: optionalTabIdSchema,
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await ctx.gateway.goForward(tabId);
    const tab = await ctx.gateway.getTab(tabId);
    return { wentForward: true, tabId, loaded: tab ? (tab.ready ?? tab.status !== "loading") : false };
  },
});

export const restoreClosedTabTool = defineTool({
  name: "restore_closed_tab",
  description: "Reopen the most recently closed tab (or a specific one by sessionId).",
  inputSchema: z.object({ sessionId: z.string().optional() }),
  async execute(input, ctx) {
    const tab = await ctx.gateway.restoreClosedTab(input.sessionId ?? "");
    return tab ? { restored: true, tabId: tab.id, url: tab.url } : { restored: false, reason: "No closed tab found" };
  },
});

export const undoLastActionTool = defineTool({
  name: "undo_last_action",
  description: "Undo the last undoable browser action (closed tab, changed input value). Not all actions are undoable.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const undoable = ctx.gateway.popUndoable();
    if (!undoable) return { undone: false, reason: "Nothing to undo" };
    if (undoable.kind === "close_tab") {
      const tab = await ctx.gateway.restoreClosedTab(undoable.sessionId);
      return tab ? { undone: true, reopenedTab: tab.id, url: tab.url } : { undone: false, reason: "Tab could not be restored" };
    }
    // input_value undo
    await ctx.gateway.undoInput(undoable.tabId, undoable.elementId);
    return { undone: true, restoredInput: undoable.elementId };
  },
});
