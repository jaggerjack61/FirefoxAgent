/**
 * Shared test fakes: in-memory store, fake gateway, scripted provider.
 * Used by unit + integration tests so nothing touches real Firefox APIs.
 */

import type { BrowserGateway, DownloadFileOptions, DownloadResult, ElementDescriptor, InteractionResult, NavigateResult, TabMeta, UndoableAction } from "@/shared/browserGateway";
import type { ContentResponse, PageSnapshot } from "@/shared/contentProtocol";
import type { MemoryStore, TaskRecord } from "@/memory/MemoryStore";
import type { ConversationRecord, ChatMessageRecord, Fact, ProviderConfig, Workspace } from "@/shared/types";
import type { LLMProvider, SendOptions } from "@/providers/LLMProvider";
import type { LLMRequest, LLMResponse, ModelCapabilities } from "@/shared/types";

// ---------------------------------------------------------------------------
// In-memory MemoryStore
// ---------------------------------------------------------------------------

export class FakeMemoryStore implements MemoryStore {
  conversations = new Map<string, ConversationRecord>();
  messages = new Map<string, ChatMessageRecord>();
  workspace: Workspace | null = null;
  facts: Fact[] = [];
  tasks = new Map<string, TaskRecord>();
  provider: ProviderConfig | null = null;

  saveConversation(conv: ConversationRecord): Promise<void> {
    this.conversations.set(conv.id, conv);
    return Promise.resolve();
  }
  loadConversation(id: string): Promise<ConversationRecord | null> {
    return Promise.resolve(this.conversations.get(id) ?? null);
  }
  loadAllConversations(): Promise<ConversationRecord[]> {
    return Promise.resolve([...this.conversations.values()]);
  }
  deleteConversation(id: string): Promise<void> {
    this.conversations.delete(id);
    return Promise.resolve();
  }
  saveMessage(msg: ChatMessageRecord): Promise<void> {
    this.messages.set(msg.id, msg);
    return Promise.resolve();
  }
  async loadMessages(conversationId: string): Promise<ChatMessageRecord[]> {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async clearConversationMessages(conversationId: string): Promise<void> {
    for (const [id, m] of this.messages) if (m.conversationId === conversationId) this.messages.delete(id);
  }
  saveWorkspace(ws: Workspace): Promise<void> {
    this.workspace = ws;
    return Promise.resolve();
  }
  loadWorkspace(): Promise<Workspace | null> {
    return Promise.resolve(this.workspace);
  }
  saveFacts(facts: Fact[]): Promise<void> {
    this.facts = [...this.facts, ...facts];
    return Promise.resolve();
  }
  loadFacts(): Promise<Fact[]> {
    return Promise.resolve(this.facts);
  }
  clearFacts(): Promise<void> {
    this.facts = [];
    return Promise.resolve();
  }
  saveTask(task: TaskRecord): Promise<void> {
    this.tasks.set(task.id, task);
    return Promise.resolve();
  }
  loadTask(id: string): Promise<TaskRecord | null> {
    return Promise.resolve(this.tasks.get(id) ?? null);
  }
  saveProvider(config: ProviderConfig): Promise<void> {
    this.provider = config;
    return Promise.resolve();
  }
  loadProvider(): Promise<ProviderConfig | null> {
    return Promise.resolve(this.provider);
  }
  async clearAll(): Promise<void> {
    this.conversations.clear();
    this.messages.clear();
    this.workspace = null;
    this.facts = [];
    this.tasks.clear();
    this.provider = null;
  }
}

// ---------------------------------------------------------------------------
// Fake BrowserGateway
// ---------------------------------------------------------------------------

export interface FakePage {
  url: string;
  title: string;
  snapshot: PageSnapshot;
}

export class FakeGateway implements BrowserGateway {
  tabs: TabMeta[] = [];
  activeTabId = 1;
  pages = new Map<number, FakePage>();
  clicks: { tabId: number; elementId: string }[] = [];
  typed: { tabId: number; elementId: string; text: string }[] = [];
  opened: { url: string; background?: boolean }[] = [];
  switched: number[] = [];
  navigated: { tabId: number; url: string }[] = [];
  closed: number[] = [];
  reloaded: number[] = [];
  downloads: Array<{ url: string; options: DownloadFileOptions }> = [];
  undoStack: UndoableAction[] = [];
  hasAccess = true;

  constructor(seed?: { tabs: { id: number; title: string; url: string }[]; pages: Record<number, FakePage | PageSnapshot> }) {
    if (seed) {
      this.tabs = seed.tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.id === this.activeTabId, windowId: 1, pinned: false }));
      for (const [id, page] of Object.entries(seed.pages)) {
        // Accept either a FakePage wrapper or a raw PageSnapshot.
        if ("snapshot" in page) this.pages.set(Number(id), page as FakePage);
        else this.pages.set(Number(id), { url: (page as PageSnapshot).url, title: (page as PageSnapshot).title, snapshot: page as PageSnapshot });
      }
    }
  }

  listTabs(): Promise<TabMeta[]> {
    return Promise.resolve([...this.tabs]);
  }
  getActiveTab(): Promise<TabMeta | null> {
    return Promise.resolve(this.tabs.find((t) => t.id === this.activeTabId) ?? null);
  }
  getTab(tabId: number): Promise<TabMeta | null> {
    return Promise.resolve(this.tabs.find((t) => t.id === tabId) ?? null);
  }
  async switchTab(tabId: number): Promise<void> {
    this.switched.push(tabId);
    this.activeTabId = tabId;
  }
  async openTab(url: string, opts?: { active?: boolean; background?: boolean; windowId?: number; index?: number }): Promise<TabMeta> {
    this.opened.push({ url, background: opts?.background });
    const id = Math.max(0, ...this.tabs.map((t) => t.id)) + 1;
    const meta = { id, title: url, url, active: !opts?.background, windowId: 1, pinned: false };
    this.tabs.push(meta);
    if (!opts?.background) this.activeTabId = id;
    return Promise.resolve(meta);
  }
  async closeTab(tabId: number): Promise<void> {
    this.closed.push(tabId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
  }
  reloadTab(tabId: number): Promise<void> {
    this.reloaded.push(tabId);
    return Promise.resolve();
  }
  async duplicateTab(tabId: number): Promise<TabMeta> {
    const t = this.tabs.find((x) => x.id === tabId);
    const id = Math.max(0, ...this.tabs.map((x) => x.id)) + 1;
    const copy = { id, title: t?.title ?? "", url: t?.url ?? "", active: false, windowId: 1, pinned: false };
    this.tabs.push(copy);
    return Promise.resolve(copy);
  }
  goBack(_tabId: number): Promise<void> {
    return Promise.resolve();
  }
  goForward(_tabId: number): Promise<void> {
    return Promise.resolve();
  }
  restoreClosedTab(_sessionId: string): Promise<TabMeta | null> {
    return Promise.resolve(null);
  }
  waitForTabReady(_tabId: number, _timeoutMs?: number): Promise<boolean> {
    return Promise.resolve(true);
  }
  hasHostAccess(_url: string): Promise<boolean> {
    return Promise.resolve(this.hasAccess);
  }
  ensureContentScripts(): Promise<void> {
    return Promise.resolve();
  }
  isContentScriptAvailable(_tabId: number): Promise<boolean> {
    return Promise.resolve(true);
  }
  async getSnapshot(tabId: number): Promise<PageSnapshot> {
    const page = this.pages.get(tabId);
    if (!page) throw new Error(`No fake page for tab ${tabId}`);
    return page.snapshot;
  }
  sendToFrame(tabId: number, frameId: number, request: { kind: string; [k: string]: unknown }): Promise<ContentResponse> {
    void tabId;
    void frameId;
    void request;
    return Promise.resolve({ ok: false, error: "NOT_IMPLEMENTED", message: "sendToFrame not implemented in fake" });
  }
  async clickElement(tabId: number, elementId: string): Promise<InteractionResult> {
    this.clicks.push({ tabId, elementId });
    return { success: true, observation: `Clicked ${elementId}.`, pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async typeText(tabId: number, elementId: string, text: string): Promise<InteractionResult> {
    this.typed.push({ tabId, elementId, text });
    return { success: true, observation: `Typed into ${elementId}.`, pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async clearInput(tabId: number, elementId: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    return { success: true, observation: "Cleared.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async selectOption(tabId: number, elementId: string, value: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    void value;
    return { success: true, observation: "Selected.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async setChecked(tabId: number, elementId: string, checked: boolean): Promise<InteractionResult> {
    void tabId;
    void elementId;
    void checked;
    return { success: true, observation: "Checked.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async scroll(tabId: number, dx: number, dy: number): Promise<InteractionResult> {
    void tabId;
    void dx;
    void dy;
    return { success: true, observation: "Scrolled.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async scrollToElement(tabId: number, elementId: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    return { success: true, observation: "Scrolled to.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async hover(tabId: number, elementId: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    return { success: true, observation: "Hovered.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async pressKey(tabId: number, key: string, elementId?: string): Promise<InteractionResult> {
    void tabId;
    void key;
    void elementId;
    return { success: true, observation: "Key pressed.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async restoreInput(tabId: number, elementId: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    return { success: true, observation: "Restored.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async undoInput(tabId: number, elementId: string): Promise<InteractionResult> {
    void tabId;
    void elementId;
    return { success: true, observation: "Undone.", pageChanged: false, newElements: [], tabId, url: "", title: "" };
  }
  async describeElement(_tabId: number, _elementId: string): Promise<ElementDescriptor | null> {
    return null;
  }
  async navigate(tabId: number, url: string): Promise<NavigateResult> {
    this.navigated.push({ tabId, url });
    const tab = this.tabs.find((t) => t.id === tabId);
    if (tab) tab.url = url;
    return { success: true, observation: `Navigated to ${url}.`, pageChanged: true, newElements: [], tabId, url, title: "", finalUrl: url, loaded: true, networkIdle: true };
  }
  async downloadFile(url: string, options: DownloadFileOptions = {}): Promise<DownloadResult> {
    this.downloads.push({ url, options });
    return {
      queued: true,
      downloadId: this.downloads.length,
      url,
      ...(options.filename ? { requestedFilename: options.filename } : {}),
      saveAs: options.saveAs ?? false,
      conflictAction: options.conflictAction ?? "uniquify",
    };
  }
  recordUndoable(action: UndoableAction): void {
    this.undoStack.push(action);
  }
  popUndoable(): UndoableAction | undefined {
    return this.undoStack.pop();
  }
}

// ---------------------------------------------------------------------------
// Scripted LLM provider
// ---------------------------------------------------------------------------

export class FakeProvider implements LLMProvider {
  readonly id = "fake";
  readonly name = "Fake";
  script: LLMResponse[] = [];
  requests: LLMRequest[] = [];
  capabilitiesOverride?: Partial<ModelCapabilities>;

  constructor(script: LLMResponse[] = []) {
    this.script = script;
  }

  capabilities(): ModelCapabilities {
    return {
      tools: true,
      streaming: false,
      parallelTools: true,
      structuredOutput: true,
      maxContextTokens: 128_000,
      ...this.capabilitiesOverride,
    };
  }
  supportsToolCalling(): boolean {
    return true;
  }
  supportsStreaming(): boolean {
    return false;
  }
  async send(request: LLMRequest, _opts?: SendOptions): Promise<LLMResponse> {
    this.requests.push(request);
    const next = this.script.shift();
    if (!next) throw new Error("FakeProvider: script exhausted");
    return next;
  }
}
