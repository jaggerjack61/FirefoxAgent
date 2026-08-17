/**
 * Page inspection tools: metadata, text, structure, links, forms, buttons,
 * inputs, and text search. All reads go through privacy gating and return
 * compact semantic representations only.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";
import { ToolError } from "@/shared/errors";
import { gatePageDataRequest } from "@/security/privacy";

interface ToolContextLike {
  gateway: { getActiveTab(): Promise<{ id: number } | null> };
  settings: { privacy: Parameters<typeof gatePageDataRequest>[0] };
  dev?: (event: unknown) => void;
}

const tabParam = z.object({ tabId: z.number().int().positive().optional() });

/** Resolves the target tab: explicit or active. */
async function resolveTab(ctx: unknown, tabId?: number): Promise<number> {
  const c = ctx as ToolContextLike;
  if (tabId) return tabId;
  const active = await c.gateway.getActiveTab();
  if (!active) throw new ToolError("TAB_NOT_FOUND", "No active tab available");
  return active.id;
}

/** Privacy gate before reading page content. */
async function assertPageReadAllowed(ctx: unknown, tabId: number, wants: { text: boolean; forms: boolean; links: boolean }): Promise<void> {
  const c = ctx as ToolContextLike;
  const active = await c.gateway.getActiveTab();
  const verdict = gatePageDataRequest(c.settings.privacy, {
    isActiveTab: active?.id === tabId,
    wants: { ...wants, snapshot: wants.text },
  });
  if (!verdict.allowed) {
    throw new ToolError("PRIVACY_BLOCKED", verdict.reason ?? "Blocked by privacy settings", {
      suggestedAction: "Enable page content sharing in Settings → Privacy & access.",
    });
  }
}

export const getPageMetadataTool = defineTool({
  name: "get_page_metadata",
  description: "Get metadata (title, url, language) of a tab's current page.",
  exposeToModel: false,
  inputSchema: tabParam,
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, (input as { tabId?: number }).tabId);
    const tab = await ctx.gateway.getTab(tabId);
    if (!tab) throw new ToolError("TAB_NOT_FOUND", `Tab ${tabId} does not exist`);
    return { tabId, title: tab.title, url: tab.url };
  },
});

export const getPageTextTool = defineTool({
  name: "get_page_text",
  description:
    "Read the current page's rendered text (truncated) and clickable elements, including links, buttons, and detectable JavaScript controls. The active-page content is already in context, so use this only when it was unavailable, truncated, or an explicit other tab is targeted.",
  inputSchema: tabParam,
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, (input as { tabId?: number }).tabId);
    await assertPageReadAllowed(ctx, tabId, { text: true, forms: false, links: true });
    const maxChars = ctx.settings.limits.maxPageTextChars;
    const snap = await ctx.gateway.getSnapshot(tabId, {
      maxTextChars: maxChars,
      maxElements: ctx.settings.limits.maxSnapshotElements,
      maxLinks: 0,
      includeFrames: true,
    });
    ctx.dev?.({ kind: "snapshot", ts: Date.now(), tabId, url: snap.url, elements: snap.elements.length, textChars: snap.text.length });
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      networkIdle: snap.networkIdle,
      truncated: snap.truncated,
      text: snap.text,
      clickable: snap.elements.map((element) => ({
        id: element.id,
        role: element.role,
        name: element.name,
        tag: element.tag,
        type: element.type,
        href: element.href,
        visible: element.visible,
        inFrame: element.inFrame,
      })),
    };
  },
});

export const getVisibleTextTool = defineTool({
  name: "get_visible_text",
  description: "Get only text currently rendered inside the active viewport. Defaults to the current page.",
  inputSchema: tabParam,
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, (input as { tabId?: number }).tabId);
    await assertPageReadAllowed(ctx, tabId, { text: true, forms: false, links: false });
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "get_visible_text", maxChars: ctx.settings.limits.maxPageTextChars });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    const tab = await ctx.gateway.getTab(tabId);
    return { tabId, url: tab?.url ?? "", text: resp.data };
  },
});

export const getPageStructureTool = defineTool({
  name: "get_page_structure",
  description: "Get the heading outline of the page (h1..h6) to understand its structure.",
  inputSchema: tabParam,
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, (input as { tabId?: number }).tabId);
    await assertPageReadAllowed(ctx, tabId, { text: true, forms: false, links: false });
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: 0, maxTextChars: 0, maxLinks: 0 });
    return { tabId, title: snap.title, url: snap.url, networkIdle: snap.networkIdle, headings: snap.headings };
  },
});

export const getLinksTool = defineTool({
  name: "get_links",
  description: "Get the links on the page as {text, href} pairs (capped).",
  exposeToModel: false,
  inputSchema: z.object({ tabId: z.number().int().positive().optional(), max: z.number().int().min(1).max(500).optional() }),
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, input.tabId);
    await assertPageReadAllowed(ctx, tabId, { text: false, forms: false, links: true });
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: 0, maxTextChars: 0, maxLinks: input.max ?? 200 });
    return { tabId, url: snap.url, links: snap.links };
  },
});

export const getFormsTool = defineTool({
  name: "get_forms",
  description: "Get form fields and submit buttons on the page. Password fields are always excluded.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    includeValues: z.boolean().optional().describe("Include current field values (requires privacy setting 'form values')"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, input.tabId);
    await assertPageReadAllowed(ctx, tabId, { text: false, forms: input.includeValues ?? false, links: false });
    const includeValues = input.includeValues && ctx.settings.privacy.allowFormValues;
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: 0, maxTextChars: 0, maxLinks: 0, includeValues });
    return { tabId, url: snap.url, forms: snap.forms };
  },
});

export const getButtonsTool = defineTool({
  name: "get_buttons",
  description: "Get the buttons on the page with their ids and names.",
  exposeToModel: false,
  inputSchema: tabParam,
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, (input as { tabId?: number }).tabId);
    await assertPageReadAllowed(ctx, tabId, { text: false, forms: false, links: false });
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: ctx.settings.limits.maxSnapshotElements, maxTextChars: 0, maxLinks: 0 });
    return { tabId, buttons: snap.elements.filter((e) => e.role === "button").map((e) => ({ id: e.id, name: e.name, visible: e.visible })) };
  },
});

export const getInputsTool = defineTool({
  name: "get_inputs",
  description: "Get the input fields on the page with their ids and labels.",
  exposeToModel: false,
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    includeValues: z.boolean().optional(),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, input.tabId);
    await assertPageReadAllowed(ctx, tabId, { text: false, forms: false, links: false });
    const includeValues = input.includeValues && ctx.settings.privacy.allowFormValues;
    const snap = await ctx.gateway.getSnapshot(tabId, { maxElements: ctx.settings.limits.maxSnapshotElements, maxTextChars: 0, maxLinks: 0, includeValues });
    const inputs = snap.elements.filter((e) => ["input", "textarea", "select", "textbox"].includes(e.role));
    return {
      tabId,
      inputs: inputs.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type ?? e.role,
        value: e.value,
        required: e.required,
        inFrame: e.inFrame,
      })),
    };
  },
});

export const findTextTool = defineTool({
  name: "find_text",
  description: "Search the page text for a phrase and return matching snippets with element ids (if any).",
  inputSchema: z.object({ tabId: z.number().int().positive().optional(), query: z.string().min(1).max(200) }),
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, input.tabId);
    await assertPageReadAllowed(ctx, tabId, { text: true, forms: false, links: false });
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "find_text", query: input.query, maxResults: 10 });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return { tabId, results: resp.data };
  },
});

export const getSnapshotTool = defineTool({
  name: "get_page_snapshot",
  description:
    "Refresh or expand the current page's interactive element map. ACTIVE TAB already contains a snapshot, so call this only when that context is unavailable, truncated, or stale after a page change.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    maxElements: z.number().int().min(1).max(300).optional(),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTab(ctx, input.tabId);
    await assertPageReadAllowed(ctx, tabId, { text: true, forms: false, links: true });
    const snap = await ctx.gateway.getSnapshot(tabId, {
      maxTextChars: ctx.settings.limits.maxPageTextChars,
      maxElements: input.maxElements ?? ctx.settings.limits.maxSnapshotElements,
      maxLinks: 60,
      includeFrames: true,
    });
    ctx.dev?.({ kind: "snapshot", ts: Date.now(), tabId, url: snap.url, elements: snap.elements.length, textChars: snap.text.length });
    return {
      tabId,
      url: snap.url,
      title: snap.title,
      networkIdle: snap.networkIdle,
      elements: snap.elements.map((e) => ({
        id: e.id,
        role: e.role,
        name: e.name,
        type: e.type,
        value: e.value,
        checked: e.checked,
        href: e.href,
        required: e.required,
        visible: e.visible,
      })),
      headings: snap.headings.slice(0, 20),
      text: snap.text.slice(0, Math.min(snap.text.length, ctx.settings.limits.maxPageTextChars)),
      truncated: snap.truncated,
    };
  },
});
