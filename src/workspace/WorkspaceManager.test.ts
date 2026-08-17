import { describe, it, expect, beforeEach } from "vitest";
import { WorkspaceManager } from "./WorkspaceManager";
import { FakeMemoryStore } from "@/test/fakes";

function createManager() {
  const store = new FakeMemoryStore();
  const ws = new WorkspaceManager({ storage: store });
  return { store, ws };
}

beforeEach(() => {});

describe("WorkspaceManager", () => {
  it("creates a workspace with a conversation id", async () => {
    const { ws } = createManager();
    const w = await ws.newWorkspace("Laptop Research");
    expect(w.name).toBe("Laptop Research");
    expect(w.conversationId).toBeTruthy();
    expect(w.tabs).toEqual([]);
  });

  it("adds tabs and avoids duplicates", async () => {
    const { ws } = createManager();
    await ws.newWorkspace();
    await ws.addTab(3, { url: "https://lenovo.example/x1", title: "Lenovo ThinkPad X1" });
    await ws.addTab(7, { url: "https://dell.example/7450", title: "Dell Latitude 7450" });
    await ws.addTab(3, { url: "https://lenovo.example/x1", title: "Lenovo ThinkPad X1" });

    const tabs = ws.getWorkspace()!.tabs;
    expect(tabs).toHaveLength(2);
    expect(ws.getTab(7)?.title).toBe("Dell Latitude 7450");
  });

  it("records inspection summaries and facts per tab", async () => {
    const { ws } = createManager();
    await ws.newWorkspace();
    await ws.recordInspection(3, {
      url: "https://lenovo.example/x1",
      title: "Lenovo ThinkPad X1",
      summary: "Product page",
      facts: [{ text: "$1,499" }, { text: "32GB RAM" }],
    });
    const tab = ws.getTab(3)!;
    expect(tab.summary).toBe("Product page");
    expect(tab.importantFacts.map((f) => f.text)).toEqual(["$1,499", "32GB RAM"]);
    expect(tab.lastInspectedAt).toBeTruthy();
  });

  it("deduplicates identical facts", async () => {
    const { ws } = createManager();
    await ws.newWorkspace();
    await ws.recordInspection(3, { url: "u", title: "t", facts: [{ text: "32GB RAM" }] });
    await ws.recordInspection(3, { url: "u", title: "t", facts: [{ text: "32GB RAM" }] });
    expect(ws.getTab(3)!.importantFacts).toHaveLength(1);
  });

  it("marks facts stale when the tab URL changes after inspection", async () => {
    const { ws } = createManager();
    await ws.newWorkspace();
    await ws.recordInspection(3, { url: "https://a.test/page1", title: "Page 1", facts: [{ text: "Old fact" }] });
    const changed = await ws.markTabPageChanged(3, "https://a.test/page2");
    expect(changed).toBe(true);
    const tab = ws.getTab(3)!;
    expect(tab.pageChangedSinceInspection).toBe(true);
    expect(tab.importantFacts[0].stale).toBe(true);
    expect(tab.url).toBe("https://a.test/page2");
  });

  it("does not mark stale when the URL is unchanged", async () => {
    const { ws } = createManager();
    await ws.newWorkspace();
    await ws.recordInspection(3, { url: "https://a.test", title: "A" });
    const changed = await ws.markTabPageChanged(3, "https://a.test");
    expect(changed).toBe(false);
  });

  it("keeps facts in long-term memory when a tab is removed", async () => {
    const { store, ws } = createManager();
    await ws.newWorkspace();
    await ws.recordInspection(3, { url: "u", title: "t", facts: [{ text: "Keep me" }] });
    await ws.removeTab(3, { keepFactsAsMemory: true });
    expect(ws.getTab(3)).toBeUndefined();
    const facts = await store.loadFacts();
    expect(facts.some((f) => f.text === "Keep me")).toBe(true);
    expect(facts.every((f) => f.stale)).toBe(true);
  });

  it("clears the workspace but keeps its identity", async () => {
    const { ws } = createManager();
    await ws.newWorkspace("Research");
    await ws.addTab(1, { url: "u", title: "t" });
    await ws.clearWorkspace();
    expect(ws.getWorkspace()!.tabs).toEqual([]);
    expect(ws.getWorkspace()!.name).toBe("Research");
  });

  it("renders a compact model representation", async () => {
    const { ws } = createManager();
    await ws.newWorkspace("Laptop Research");
    await ws.recordInspection(3, {
      url: "https://lenovo.example/x1",
      title: "Lenovo ThinkPad X1",
      summary: "Product page for ThinkPad X1",
      facts: [{ text: "$1,499" }, { text: "32GB RAM" }],
    });
    const rendered = ws.renderForModel();
    expect(rendered).toContain("WORKSPACE: Laptop Research");
    expect(rendered).toContain("Tab 3");
    expect(rendered).toContain("Lenovo ThinkPad X1");
    expect(rendered).toContain("$1,499");
    expect(rendered).toContain("32GB RAM");
    // Never sends raw page text.
    expect(rendered).not.toContain("<html");
  });
});
