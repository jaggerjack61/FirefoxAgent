/**
 * TabCoordinator: owns browser tab lifecycle behavior for the agent.
 *  - watches tab open/close/activate/update events
 *  - keeps workspace tab entries in sync (closed tabs, URL changes)
 *  - captures closed-tab session ids for the undo tool
 *  - forwards state changes to the sidebar
 */

import type { BackgroundEvent } from "@/shared/events";
import type { WorkspaceManager } from "@/workspace/WorkspaceManager";

export interface EventSink {
  emit(event: BackgroundEvent): void;
}

export class TabCoordinator {
  private readonly closedTabs: { tabId: number; sessionId: string; url: string; title: string }[] = [];

  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly sink: EventSink,
  ) {}

  start(): void {
    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.url) void this.handleUrlChange(tabId, changeInfo.url);
      if (changeInfo.title) void this.workspace.updateTabTitle(tabId, tab.title ?? "");
      void changeInfo;
    });
    browser.tabs.onRemoved.addListener((tabId, removeInfo) => void this.handleRemoved(tabId, removeInfo));
    browser.tabs.onActivated.addListener((info) => this.handleActivated(info.tabId));
    void browser.sessions.getRecentlyClosed({}).then((sessions) => {
      for (const s of sessions) {
        if (s.tab?.id !== undefined && s.tab.url) {
          this.closedTabs.push({ tabId: s.tab.id, sessionId: s.tab.sessionId ?? "", url: s.tab.url, title: s.tab.title ?? "" });
        }
      }
    });
  }

  /** Closed-tab record for undo (most recent first). */
  getClosedTab(sessionId?: string): { tabId: number; sessionId: string; url: string; title: string } | undefined {
    if (sessionId) return this.closedTabs.find((t) => t.sessionId === sessionId);
    return this.closedTabs[this.closedTabs.length - 1];
  }

  private async handleUrlChange(tabId: number, url: string): Promise<void> {
    // Substantial URL change → the tab's page context is stale.
    const changed = await this.workspace.markTabPageChanged(tabId, url);
    if (changed) this.emitWorkspace();
  }

  private async handleRemoved(tabId: number, _info: { windowId: number; isWindowClosing: boolean }): Promise<void> {
    const entry = this.workspace.getTab(tabId);
    if (entry) {
      // Facts survive as historical notes but the tab entry is dropped.
      await this.workspace.removeTab(tabId, { keepFactsAsMemory: true });
      this.emitWorkspace();
    }
    const sessions = await browser.sessions.getRecentlyClosed({});
    const session = sessions.find((s) => s.tab?.id === tabId);
    if (session?.tab) {
      this.closedTabs.push({ tabId, sessionId: session.tab.sessionId ?? "", url: session.tab.url ?? "", title: session.tab.title ?? "" });
      if (this.closedTabs.length > 20) this.closedTabs.shift();
    }
  }

  private handleActivated(tabId: number): void {
    this.workspace.setActiveTab(tabId);
    this.emitWorkspace();
  }

  private emitWorkspace(): void {
    const ws = this.workspace.getWorkspace();
    if (ws) this.sink.emit({ type: "WORKSPACE_CHANGED", workspace: ws });
  }
}
