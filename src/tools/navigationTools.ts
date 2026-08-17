/**
 * Navigation and web-search tools.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";
import { ToolError } from "@/shared/errors";

async function resolveTabId(ctx: { gateway: { getActiveTab(): Promise<{ id: number } | null> } }, tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const active = await ctx.gateway.getActiveTab();
  if (!active) throw new ToolError("TAB_NOT_FOUND", "No active tab available");
  return active.id;
}

export const navigateTool = defineTool({
  name: "navigate",
  description:
    "Navigate the current tab to a URL unless an explicit tabId is supplied. Returns the loaded page's compact element list.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    url: z.string().url().describe("The absolute URL to navigate to"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.navigate(tabId, input.url, { timeoutMs: 15_000 });
    return result;
  },
});

const SEARCH_URLS: Record<string, (q: string) => string> = {
  google: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  duckduckgo: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
  bing: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
};

export const searchWebTool = defineTool({
  name: "search_web",
  description:
    "Search the web in the current tab by default. Supply tabId for an explicitly referenced tab, or newTab/openInBackground only when the user asks for another tab. Returns result links.",
  inputSchema: z.object({
    query: z.string().min(1).max(500).describe("Search query"),
    tabId: z.number().int().positive().optional().describe("Explicit target tab; default is the current tab"),
    newTab: z.boolean().optional().default(false).describe("Open a new foreground tab"),
    openInBackground: z.boolean().optional().default(false),
  }),
  async execute(input, ctx) {
    const engine = ctx.settings.searchEngine;
    const url = SEARCH_URLS[engine]?.(input.query) ?? SEARCH_URLS.google(input.query);
    let tabId: number;
    if (input.newTab || input.openInBackground) {
      const created = await ctx.gateway.openTab(url, { background: input.openInBackground });
      tabId = created.id;
    } else {
      tabId = await resolveTabId(ctx, input.tabId);
      await ctx.gateway.navigate(tabId, url);
    }
    // Return a compact snapshot of the results page.
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: 60, maxTextChars: 0, maxLinks: 0, includeFrames: true });
    return {
      engine,
      query: input.query,
      tabId,
      url: snap.url,
      title: snap.title,
      loaded: true,
      networkIdle: snap.networkIdle ?? true,
      resultsPreview: snap.elements
        .filter((e) => e.role === "link" && e.visible)
        .slice(0, 20)
        .map((e) => ({ id: e.id, text: e.name, href: e.href })),
    };
  },
});
