import { describe, it, expect } from "vitest";
import { createToolRegistry } from "./index";
import { ToolError } from "@/shared/errors";
import type { AppSettings } from "@/shared/types";
import { DEFAULT_SETTINGS } from "@/settings/SettingsRepository";
import { FakeGateway } from "@/test/fakes";

const context = {
  gateway: new FakeGateway(),
  workspace: undefined as never,
  settings: DEFAULT_SETTINGS as AppSettings,
  signal: undefined,
  dev: () => undefined,
};

describe("ToolRegistry", () => {
  it("registers all tools without duplicates", () => {
    const registry = createToolRegistry();
    const names = registry.names();
    expect(names).toContain("list_tabs");
    expect(names).toContain("click_element");
    expect(names).toContain("get_workspace_tabs");
    expect(names).toContain("search_web");
    expect(new Set(names).size).toBe(names.length);
  });

  it("produces LLM tool definitions with JSON schemas", () => {
    const registry = createToolRegistry();
    const defs = registry.llmToolDefs();
    const switchTab = defs.find((d) => d.function.name === "switch_tab");
    expect(switchTab).toBeDefined();
    const params = switchTab!.function.parameters as { properties: Record<string, { type: string }>; required: string[] };
    expect(params.properties.tabId.type).toBe("integer");
    expect(params.required).toContain("tabId");
  });

  it("hides compatibility aliases and exposes consolidated tools", () => {
    const registry = createToolRegistry();
    const exposed = registry.llmToolDefs().map((definition) => definition.function.name);
    expect(exposed).toContain("set_checkbox");
    expect(exposed).toContain("close_tabs");
    expect(exposed).not.toContain("check_checkbox");
    expect(exposed).not.toContain("uncheck_checkbox");
    expect(exposed).not.toContain("get_links");
    expect(exposed.length).toBeLessThan(registry.names().length);
  });

  it("includes parameter schemas for structured-output fallback models", () => {
    const registry = createToolRegistry();
    const descriptions = registry.toolDescriptions(["switch_tab"], true);
    expect(descriptions).toContain("Parameters:");
    expect(descriptions).toContain("tabId");
  });

  it("validates model input against the schema", () => {
    const registry = createToolRegistry();
    const validated = registry.validateCall("switch_tab", { tabId: 7 });
    expect(validated).toEqual({ tabId: 7 });
  });

  it("rejects invalid input with INVALID_TOOL_ARGUMENTS", () => {
    const registry = createToolRegistry();
    expect(() => registry.validateCall("switch_tab", { tabId: "not-a-number" })).toThrow(ToolError);
    try {
      registry.validateCall("switch_tab", {});
    } catch (err) {
      expect((err as ToolError).code).toBe("INVALID_TOOL_ARGUMENTS");
    }
  });

  it("rejects unknown tools with TOOL_NOT_FOUND", () => {
    const registry = createToolRegistry();
    expect(() => registry.validateCall("delete_everything", {})).toThrow(/does not exist/);
  });

  it("executes a tab tool through the gateway", async () => {
    const registry = createToolRegistry();
    const gateway = new FakeGateway({
      tabs: [{ id: 1, title: "A", url: "https://a.test" }],
      pages: {},
    });
    const output = await registry.executeCall("list_tabs", {}, { ...context, gateway });
    expect((output as { tabs: unknown[] }).tabs).toHaveLength(1);
  });

  it("returns clickable elements with a page text read", async () => {
    const gateway = new FakeGateway({
      tabs: [{ id: 1, title: "Example", url: "https://example.test" }],
      pages: {
        1: {
          url: "https://example.test",
          title: "Example",
          capturedAt: 1,
          version: 1,
          elements: [
            {
              id: "E1",
              role: "link",
              name: "Documentation",
              tag: "a",
              href: "https://example.test/docs",
              visible: true,
              enabled: true,
              clickable: true,
              actionable: true,
              inFrame: false,
              frameId: 0,
            },
            {
              id: "E2",
              role: "button",
              name: "Open menu",
              tag: "div",
              visible: true,
              enabled: true,
              clickable: true,
              actionable: true,
              inFrame: false,
              frameId: 0,
            },
          ],
          text: "Example page",
          headings: [],
          links: [],
          forms: [],
          tableCount: 0,
          listCount: 0,
          truncated: false,
          networkIdle: true,
        },
      },
    });

    const output = await createToolRegistry().executeCall("get_page_text", {}, { ...context, gateway }) as {
      text: string;
      clickable: Array<{ id: string; role: string; name: string; tag: string; href?: string }>;
    };

    expect(output.text).toBe("Example page");
    expect(output.clickable).toEqual([
      expect.objectContaining({ id: "E1", role: "link", name: "Documentation", tag: "a", href: "https://example.test/docs" }),
      expect.objectContaining({ id: "E2", role: "button", name: "Open menu", tag: "div" }),
    ]);
  });

  it("surfaces an unverified click as a tool failure", async () => {
    const gateway = new FakeGateway({
      tabs: [{ id: 1, title: "Example", url: "https://example.test" }],
      pages: {},
    });
    gateway.clickElement = async (tabId, elementId) => ({
      success: false,
      tabId,
      observation: `Click ${elementId} was not verified.`,
      error: {
        code: "ACTION_NOT_VERIFIED",
        message: "The page ignored the synthetic click.",
        suggestedAction: "Click it manually.",
      },
      pageChanged: false,
      newElements: [],
      url: "https://example.test",
      title: "Example",
    });

    await expect(createToolRegistry().executeCall("click_element", { elementId: "E3" }, { ...context, gateway }))
      .rejects.toMatchObject({ code: "ACTION_NOT_VERIFIED", suggestedAction: "Click it manually." });
  });

  it("returns wired action history instead of an empty placeholder", async () => {
    const registry = createToolRegistry();
    const entries = [
      { id: "a1", at: 1, tool: "click_element", label: "Click E1", status: "ok" as const },
      { id: "a2", at: 2, tool: "type_text", label: "Type into E2", status: "ok" as const },
    ];
    const output = await registry.executeCall("get_action_history", { limit: 1 }, {
      ...context,
      actionHistory: () => entries,
    }) as { entries: typeof entries };
    expect(output.entries).toEqual([entries[1]]);
  });

  it("searches in the current tab unless a new tab is explicitly requested", async () => {
    const registry = createToolRegistry();
    const gateway = new FakeGateway({
      tabs: [{ id: 1, title: "Current", url: "https://current.test" }],
      pages: {
        1: {
          url: "https://current.test",
          title: "Current",
          capturedAt: 1,
          version: 1,
          elements: [],
          text: "",
          headings: [],
          links: [],
          forms: [],
          tableCount: 0,
          listCount: 0,
          truncated: false,
        },
      },
    });

    await registry.executeCall("search_web", { query: "firefox tools" }, { ...context, gateway });

    expect(gateway.navigated).toHaveLength(1);
    expect(gateway.navigated[0].tabId).toBe(1);
    expect(gateway.opened).toEqual([]);
  });

  it("throws TOOL_NOT_FOUND when executing an unknown tool", async () => {
    const registry = createToolRegistry();
    await expect(registry.executeCall("nope", {}, context)).rejects.toThrow(/does not exist/);
  });
});
