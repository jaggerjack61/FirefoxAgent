/**
 * WorkspaceManager: the AI workspace context.
 *
 * A workspace groups the tabs involved in the current task with per-tab
 * summaries and facts, so the agent can reason across tabs without
 * re-reading pages. Facts survive tab switches; stale facts are marked.
 *
 * This class is DOM- and API-free so it can be unit-tested directly.
 */

import type { Fact, TaskStatus, Workspace, WorkspaceTab } from "@/shared/types";
import { newId } from "@/shared/id";
import type { MemoryStore } from "@/memory/MemoryStore";

export interface WorkspaceManagerOptions {
  storage: MemoryStore;
}

export class WorkspaceManager {
  private ws: Workspace | null = null;
  private readonly storage: MemoryStore;
  /** Called whenever the workspace is mutated (persist + notify). Assigned after construction. */
  onChanged?: (ws: Workspace) => void;

  constructor(opts: WorkspaceManagerOptions) {
    this.storage = opts.storage;
  }

  async load(): Promise<void> {
    this.ws = await this.storage.loadWorkspace();
  }

  /** Access to long-term memory (facts). */
  getStorage(): MemoryStore {
    return this.storage;
  }

  getWorkspace(): Workspace | null {
    return this.ws;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async newWorkspace(name?: string): Promise<Workspace> {
    this.ws = {
      id: newId("ws"),
      name: name ?? "Research",
      conversationId: newId("conv"),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tabs: [],
    };
    await this.persist();
    return this.ws;
  }

  async clearWorkspace(): Promise<void> {
    if (!this.ws) return;
    this.ws.tabs = [];
    this.ws.activeTaskId = undefined;
    this.ws.updatedAt = Date.now();
    await this.persist();
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  getTab(tabId: number): WorkspaceTab | undefined {
    return this.ws?.tabs.find((t) => t.tabId === tabId);
  }

  async addTab(tabId: number, meta: { url: string; title: string }, pinned = false): Promise<WorkspaceTab> {
    if (!this.ws) await this.newWorkspace();
    const ws = this.ws!;
    let tab = ws.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      tab = { tabId, url: meta.url, title: meta.title, pinned, importantFacts: [], extractedEntities: [] };
      ws.tabs.push(tab);
    } else {
      tab.url = meta.url;
      tab.title = meta.title;
      if (pinned) tab.pinned = true;
    }
    ws.updatedAt = Date.now();
    await this.persist();
    return tab;
  }

  async removeTab(tabId: number, opts: { keepFactsAsMemory?: boolean } = {}): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    const tab = ws.tabs.find((t) => t.tabId === tabId);
    if (tab && opts.keepFactsAsMemory && tab.importantFacts.length) {
      // Keep facts in long-term memory with a note of their origin.
      const facts = tab.importantFacts.map((f) => ({ ...f, stale: true }));
      await this.storage.saveFacts(facts);
    }
    ws.tabs = ws.tabs.filter((t) => t.tabId !== tabId);
    ws.updatedAt = Date.now();
    await this.persist();
  }

  async updateTabTitle(tabId: number, title: string): Promise<void> {
    const tab = this.getTab(tabId);
    if (!tab || tab.title === title) return;
    tab.title = title;
    this.ws!.updatedAt = Date.now();
    await this.persist();
  }

  /** URL changed after inspection → snapshot stale, facts become historical. */
  async markTabPageChanged(tabId: number, url: string): Promise<boolean> {
    const tab = this.getTab(tabId);
    if (!tab) return false;
    if (tab.url === url) return false;
    if (tab.lastInspectedAt && !tab.pageChangedSinceInspection) {
      tab.pageChangedSinceInspection = true;
      for (const f of tab.importantFacts) f.stale = true;
      tab.summary = tab.summary ? `[previous page: ${tab.summary}]` : undefined;
    }
    tab.url = url;
    this.ws!.updatedAt = Date.now();
    await this.persist();
    return true;
  }

  async setTabPinned(tabId: number, pinned: boolean): Promise<void> {
    const tab = this.getTab(tabId);
    if (!tab) return;
    tab.pinned = pinned;
    this.ws!.updatedAt = Date.now();
    await this.persist();
  }

  async setActiveTab(tabId: number): Promise<void> {
    if (!this.ws) return;
    // No-op bookkeeping: active tab is tracked by the browser itself.
    void tabId;
  }

  // -------------------------------------------------------------------------
  // Inspection results (facts/summaries)
  // -------------------------------------------------------------------------

  async recordInspection(
    tabId: number,
    data: { url: string; title: string; summary?: string; facts?: Omit<Fact, "id" | "createdAt" | "sourceTabId" | "sourceUrl">[] },
  ): Promise<void> {
    const ws = this.ws;
    if (!ws) return;
    let tab = ws.tabs.find((t) => t.tabId === tabId);
    if (!tab) {
      tab = {
        tabId,
        url: data.url,
        title: data.title,
        pinned: false,
        importantFacts: [],
        extractedEntities: [],
      };
      ws.tabs.push(tab);
    }
    tab.url = data.url;
    tab.title = data.title;
    tab.lastInspectedAt = Date.now();
    tab.pageChangedSinceInspection = false;
    if (data.summary) tab.summary = data.summary;
    for (const f of data.facts ?? []) {
      const fact: Fact = {
        id: newId("fact"),
        text: f.text,
        category: f.category,
        sourceTabId: tabId,
        sourceUrl: data.url,
        createdAt: Date.now(),
      };
      // Avoid duplicate facts with identical text for the same source.
      if (!tab.importantFacts.some((existing) => existing.text === fact.text)) {
        tab.importantFacts.push(fact);
      }
    }
    if (tab.importantFacts.length > 30) tab.importantFacts = tab.importantFacts.slice(-30);
    ws.updatedAt = Date.now();
    await this.persist();
  }

  /** All facts across workspace tabs (optionally filtered by tab). */
  collectFacts(tabId?: number): Fact[] {
    if (!this.ws) return [];
    const tabs = tabId !== undefined ? this.ws.tabs.filter((t) => t.tabId === tabId) : this.ws.tabs;
    return tabs.flatMap((t) => t.importantFacts);
  }

  // -------------------------------------------------------------------------
  // Task
  // -------------------------------------------------------------------------

  getActiveTaskId(): string | undefined {
    return this.ws?.activeTaskId;
  }

  async setActiveTask(taskId: string | undefined): Promise<void> {
    if (!this.ws) return;
    this.ws.activeTaskId = taskId;
    this.ws.updatedAt = Date.now();
    await this.persist();
  }

  async updateTaskStatus(status: TaskStatus): Promise<void> {
    if (!this.ws) return;
    this.ws.updatedAt = Date.now();
    void status;
    await this.persist();
  }

  // -------------------------------------------------------------------------

  /** Renders the compact workspace context block for the model. */
  renderForModel(maxTabs = 20, opts: { factsOnly?: boolean } = {}): string {
    const ws = this.ws;
    if (!ws || ws.tabs.length === 0) return "WORKSPACE: (empty — no tabs are part of the current research context)";
    const lines: string[] = [`WORKSPACE: ${ws.name}`, `Conversation: ${ws.conversationId}`, ""];
    for (const tab of ws.tabs.slice(0, maxTabs)) {
      const pin = tab.pinned ? " [pinned]" : "";
      lines.push(`Tab ${tab.tabId}${pin}`);
      lines.push(`Title: ${tab.title}`);
      lines.push(`URL: ${tab.url}`);
      if (tab.pageChangedSinceInspection) lines.push("Note: this tab navigated after inspection — facts below are from the previous page.");
      if (tab.summary && !opts.factsOnly) lines.push(`Summary: ${tab.summary}`);
      if (tab.importantFacts.length) {
        lines.push("Important facts:");
        for (const f of tab.importantFacts) {
          lines.push(`- ${f.text}${f.stale ? " (previous page)" : ""}`);
        }
      } else if (!tab.summary && !opts.factsOnly) {
        lines.push("Not yet inspected.");
      }
      lines.push("");
    }
    return lines.join("\n").trim();
  }

  private async persist(): Promise<void> {
    if (this.ws) {
      await this.storage.saveWorkspace(this.ws);
      this.onChanged?.(this.ws);
    }
  }
}
