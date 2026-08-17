/**
 * Workspace & memory tools: the agent's window into cross-tab context,
 * task state and remembered facts.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";
import { gatePageDataRequest } from "@/security/privacy";
import { ToolError } from "@/shared/errors";
import { derivePageFacts, derivePageSummary } from "@/workspace/pageNotes";

export const getWorkspaceTabsTool = defineTool({
  name: "get_workspace_tabs",
  description:
    "Get the AI workspace: tabs involved in the current task with their summaries and important facts (e.g. prices, specs). Prefer this over re-reading pages — cached info is usually sufficient for comparisons.",
  exposeToModel: false,
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const ws = ctx.workspace.getWorkspace();
    if (!ws) return { workspace: null };
    return {
      workspaceId: ws.id,
      conversationId: ws.conversationId,
      name: ws.name,
      tabs: ws.tabs.map((t) => ({
        tabId: t.tabId,
        title: t.title,
        url: t.url,
        pinned: t.pinned,
        summary: t.summary,
        pageChangedSinceInspection: t.pageChangedSinceInspection,
        importantFacts: t.importantFacts.map((f) => ({ text: f.text, category: f.category, stale: f.stale })),
        lastInspectedAt: t.lastInspectedAt,
      })),
    };
  },
});

export const getWorkspaceMemoryTool = defineTool({
  name: "get_memory",
  description:
    "Get remembered facts from long-term memory (previous sessions and closed tabs). Useful for follow-up questions, e.g. 'which one was cheapest?'",
  exposeToModel: false,
  inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional().default(30) }),
  async execute(input, ctx) {
    const facts = await ctx.workspace.getStorage().loadFacts();
    const recent = facts.slice(-(input.limit ?? 30));
    return { memoryFacts: recent.map((f: { text: string; category?: string; stale?: boolean }) => ({ text: f.text, category: f.category, stale: f.stale })) };
  },
});

export const clearMemoryTool = defineTool({
  name: "clear_memory",
  description: "Clear the long-term memory (remembered page facts).",
  inputSchema: z.object({}),
  requiresConfirmation: true,
  async execute(_input, ctx) {
    await ctx.workspace.getStorage().clearFacts();
    return { cleared: true };
  },
});

export const addTabToWorkspaceTool = defineTool({
  name: "add_tab_to_workspace",
  description: "Add a tab to the AI workspace context by id.",
  exposeToModel: false,
  inputSchema: z.object({ tabId: z.number().int().positive() }),
  async execute(input, ctx) {
    const tab = await ctx.gateway.getTab(input.tabId);
    if (!tab) throw new Error(`Tab ${input.tabId} does not exist`);
    await ctx.workspace.addTab(input.tabId, { url: tab.url, title: tab.title });
    return { added: true, tabId: input.tabId, title: tab.title };
  },
});

export const removeTabFromWorkspaceTool = defineTool({
  name: "remove_tab_from_workspace",
  description: "Remove a tab from the AI workspace context (facts are kept in memory).",
  exposeToModel: false,
  inputSchema: z.object({ tabId: z.number().int().positive() }),
  async execute(input, ctx) {
    await ctx.workspace.removeTab(input.tabId, { keepFactsAsMemory: true });
    return { removed: true, tabId: input.tabId };
  },
});

export const rememberFactTool = defineTool({
  name: "remember_fact",
  description:
    "Store an important fact about a tab (e.g. 'Lenovo ThinkPad X1: $1,499, 32GB RAM') so it can be reused later without re-reading the page.",
  exposeToModel: false,
  inputSchema: z.object({
    tabId: z.number().int().positive().describe("The tab the fact comes from"),
    text: z.string().min(1).max(500).describe("The fact, one short sentence"),
    category: z.string().max(60).optional().describe("e.g. price, spec, contact"),
  }),
  async execute(input, ctx) {
    const tab = ctx.workspace.getTab(input.tabId);
    const meta = tab ?? { url: "", title: "" };
    await ctx.workspace.recordInspection(input.tabId, {
      url: meta.url,
      title: meta.title,
      facts: [{ text: input.text, category: input.category }],
    });
    return { remembered: true, fact: input.text };
  },
});

const factInputSchema = z.object({
  text: z.string().min(1).max(500),
  category: z.string().max(60).optional(),
});

export const saveTabNotesTool = defineTool({
  name: "save_tab_notes",
  description: "Save one concise summary and multiple important facts for a tab in a single call after inspecting it.",
  inputSchema: z.object({
    tabId: z.number().int().positive(),
    summary: z.string().min(1).max(1_000).optional(),
    facts: z.array(factInputSchema).max(20).optional().default([]),
  }).refine((input) => !!input.summary || input.facts.length > 0, "Provide a summary or at least one fact"),
  async execute(input, ctx) {
    const facts = input.facts ?? [];
    const tab = await ctx.gateway.getTab(input.tabId);
    if (!tab) throw new ToolError("TAB_NOT_FOUND", `Tab ${input.tabId} does not exist`);
    await ctx.workspace.recordInspection(input.tabId, {
      url: tab.url,
      title: tab.title,
      summary: input.summary,
      facts,
    });
    return { saved: true, tabId: input.tabId, summary: input.summary, factCount: facts.length };
  },
});

export const summarizeTabTool = defineTool({
  name: "summarize_tab",
  description:
    "Inspect a tab once and automatically store a concise local summary plus price/spec/date-like facts. Use an explicit tab id only when the user refers to another tab.",
  inputSchema: z.object({
    tabId: z.number().int().positive().describe("Tab to inspect and summarize"),
  }),
  async execute(input, ctx) {
    const tab = await ctx.gateway.getTab(input.tabId);
    if (!tab) throw new Error(`Tab ${input.tabId} does not exist`);
    const active = await ctx.gateway.getActiveTab();
    const privacy = gatePageDataRequest(ctx.settings.privacy, {
      isActiveTab: active?.id === input.tabId,
      wants: { text: true, forms: false, links: false, snapshot: true },
    });
    if (!privacy.allowed) {
      throw new ToolError("PRIVACY_BLOCKED", privacy.reason ?? "Blocked by privacy settings");
    }
    const snap = await ctx.gateway.getSnapshot(input.tabId, {
      maxTextChars: Math.min(ctx.settings.limits.maxPageTextChars, 8000),
      maxElements: 40,
      maxLinks: 0,
    });
    const summary = derivePageSummary(snap.title, snap.text, snap.headings);
    const facts = derivePageFacts(snap.text);
    await ctx.workspace.recordInspection(input.tabId, {
      url: snap.url,
      title: snap.title,
      summary,
      facts,
    });
    return {
      tabId: input.tabId,
      url: snap.url,
      title: snap.title,
      networkIdle: snap.networkIdle,
      headings: snap.headings.slice(0, 15),
      textPreview: snap.text.slice(0, 4000),
      summary,
      facts,
      truncated: snap.truncated,
    };
  },
});
