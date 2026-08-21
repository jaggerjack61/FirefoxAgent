/**
 * Extraction tools: tables, lists, links, structured content.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";
import { ToolError } from "@/shared/errors";
import { gatePageDataRequest } from "@/security/privacy";

async function resolveTabId(ctx: { gateway: { getActiveTab(): Promise<{ id: number } | null> } }, tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const active = await ctx.gateway.getActiveTab();
  if (!active) throw new ToolError("TAB_NOT_FOUND", "No active tab available");
  return active.id;
}

async function assertAllowed(ctx: { gateway: { getActiveTab(): Promise<{ id: number } | null> } }, tabId: number): Promise<void> {
  const c = ctx as unknown as { settings: { privacy: Parameters<typeof gatePageDataRequest>[0] } };
  const active = await ctx.gateway.getActiveTab();
  const verdict = gatePageDataRequest(c.settings.privacy, {
    isActiveTab: active?.id === tabId,
    wants: { text: true, forms: false, links: true, snapshot: true },
  });
  if (!verdict.allowed) {
    throw new ToolError("PRIVACY_BLOCKED", verdict.reason ?? "Blocked by privacy settings");
  }
}

export const extractTableTool = defineTool({
  name: "extract_table",
  description: "Extract the most substantial table from the page as rows of cells.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    maxRows: z.number().int().min(1).max(200).optional().default(30),
    maxCols: z.number().int().min(1).max(30).optional().default(12),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await assertAllowed(ctx, tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "extract_table", maxRows: input.maxRows ?? 30, maxCols: input.maxCols ?? 12 });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return resp.data;
  },
});

export const extractListTool = defineTool({
  name: "extract_list",
  description: "Extract the first substantial list from the page.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    maxItems: z.number().int().min(1).max(200).optional().default(50),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await assertAllowed(ctx, tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "extract_list", maxItems: input.maxItems ?? 50 });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return resp.data;
  },
});

export const extractLinksTool = defineTool({
  name: "extract_links",
  description: "Extract links from the page, optionally filtered by keyword (e.g. 'api', 'docs').",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    maxLinks: z.number().int().min(1).max(500).optional().default(100),
    filter: z.string().max(100).optional().describe("Keyword that must appear in link text or URL"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await assertAllowed(ctx, tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "extract_links", maxLinks: input.maxLinks ?? 100, filter: input.filter });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return resp.data;
  },
});

export const extractStructuredContentTool = defineTool({
  name: "extract_structured_content",
  description: "Extract main article content (headings, paragraphs, lists, code) as structured markdown-like text.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    maxChars: z.number().int().min(500).max(40_000).optional().default(12_000),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    await assertAllowed(ctx, tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "extract_structured_content", maxChars: input.maxChars ?? 12_000 });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return resp.data;
  },
});
