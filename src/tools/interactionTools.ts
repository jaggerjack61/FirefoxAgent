/**
 * Browser interaction tools: click, focus, type, clear, select, check,
 * scroll, hover, press key. All act through the gateway (content scripts)
 * using stable element ids; stale ids trigger snapshot refresh + semantic
 * rematch in the gateway.
 */

import { z } from "zod";
import { defineTool } from "./ToolRegistry";
import { ToolError } from "@/shared/errors";

const singleElement = (description: string) =>
  z.object({
    tabId: z.number().int().positive().optional(),
    elementId: z.string().describe(description),
  });

async function resolveTabId(ctx: { gateway: { getActiveTab(): Promise<{ id: number } | null> } }, tabId?: number): Promise<number> {
  if (tabId) return tabId;
  const active = await ctx.gateway.getActiveTab();
  if (!active) throw new ToolError("TAB_NOT_FOUND", "No active tab available");
  return active.id;
}

export const clickElementTool = defineTool({
  name: "click_element",
  description:
    "Click an interactive element on the current page by id. Automatically waits briefly for it to be visible, enabled, stable and unobscured, and scrolls it into view. Use ids already present in ACTIVE TAB or the latest observation; refresh the snapshot only when those ids are missing or stale. Returns the resulting page state.",
  inputSchema: singleElement("Element id from ACTIVE TAB, the latest observation, or get_page_snapshot"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.clickElement(tabId, input.elementId);
    return result;
  },
});

export const focusElementTool = defineTool({
  name: "focus_element",
  description: "Focus an element by id (no click, no value change).",
  inputSchema: singleElement("Element id from current page context or the latest observation"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "focus", elementId: input.elementId });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return { focused: true, elementId: input.elementId };
  },
});

export const typeTextTool = defineTool({
  name: "type_text",
  description:
    "Fill an input/textarea by element id, replacing its current value after it becomes visible, enabled and editable. Never used to submit forms — use press_key Enter or click the submit button explicitly. Typing into password fields requires confirmation.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    elementId: z.string().describe("Element id from current page context or the latest observation"),
    text: z.string().max(4000).describe("Text to type"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.typeText(tabId, input.elementId, input.text);
    return result;
  },
});

export const clearInputTool = defineTool({
  name: "clear_input",
  description: "Clear the value of an input/textarea by element id.",
  inputSchema: singleElement("Element id from current page context or the latest observation"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.clearInput(tabId, input.elementId);
    return result;
  },
});

export const selectOptionTool = defineTool({
  name: "select_option",
  description: "Select an option in a <select> dropdown by element id and option text/value.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    elementId: z.string().describe("Element id from current page context or the latest observation"),
    value: z.string().describe("Option value or visible text"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.selectOption(tabId, input.elementId, input.value);
    return result;
  },
});

export const checkCheckboxTool = defineTool({
  name: "check_checkbox",
  description: "Check a checkbox/radio by element id.",
  exposeToModel: false,
  inputSchema: singleElement("Element id from get_page_snapshot"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.setChecked(tabId, input.elementId, true);
    return result;
  },
});

export const uncheckCheckboxTool = defineTool({
  name: "uncheck_checkbox",
  description: "Uncheck a checkbox by element id.",
  exposeToModel: false,
  inputSchema: singleElement("Element id from get_page_snapshot"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.setChecked(tabId, input.elementId, false);
    return result;
  },
});

export const setCheckboxTool = defineTool({
  name: "set_checkbox",
  description: "Set a checkbox, radio, or switch on the current page to the requested checked state in one action.",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    elementId: z.string().describe("Element id from current page context or the latest observation"),
    checked: z.boolean(),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    return ctx.gateway.setChecked(tabId, input.elementId, input.checked);
  },
});

export const scrollTool = defineTool({
  name: "scroll",
  description: "Scroll the page by pixel offsets (positive = down/right).",
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    dx: z.number().int().optional().default(0),
    dy: z.number().int().describe("Vertical scroll amount in pixels"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.scroll(tabId, input.dx ?? 0, input.dy);
    return result;
  },
});

export const scrollToElementTool = defineTool({
  name: "scroll_to_element",
  description: "Scroll until an element by id is in view.",
  inputSchema: singleElement("Element id from current page context or the latest observation"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.scrollToElement(tabId, input.elementId);
    return result;
  },
});

export const hoverElementTool = defineTool({
  name: "hover_element",
  description: "Hover over an element by id (reveals dropdowns/tooltips).",
  inputSchema: singleElement("Element id from current page context or the latest observation"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.hover(tabId, input.elementId);
    return result;
  },
});

const KEY_NAMES = ["Enter", "Tab", "Escape", "Backspace", "Delete", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Space"];

export const pressKeyTool = defineTool({
  name: "press_key",
  description: `Press a key. Supported keys: ${KEY_NAMES.join(", ")} or a single character. Pressing Enter inside a form submits it and requires confirmation.`,
  inputSchema: z.object({
    tabId: z.number().int().positive().optional(),
    key: z.string().min(1).max(12),
    elementId: z.string().optional().describe("Optional element id to send the key to"),
  }),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.pressKey(tabId, input.key, input.elementId);
    return result;
  },
});

export const getInputHistoryTool = defineTool({
  name: "get_input_history",
  description: "Show previously typed values for an input (for undo support).",
  exposeToModel: false,
  inputSchema: singleElement("Element id from get_page_snapshot"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const resp = await ctx.gateway.sendToFrame(tabId, 0, { kind: "get_input_history", elementId: input.elementId });
    if (!resp.ok) throw new ToolError(resp.error, resp.message);
    return resp.data;
  },
});

export const restoreInputTool = defineTool({
  name: "restore_input_value",
  description: "Restore the previous value of an input changed by the agent (undo).",
  exposeToModel: false,
  inputSchema: singleElement("Element id from get_page_snapshot"),
  async execute(input, ctx) {
    const tabId = await resolveTabId(ctx, input.tabId);
    const result = await ctx.gateway.restoreInput(tabId, input.elementId);
    return result;
  },
});
