/**
 * BackgroundOrchestrator: wires the agent together in the background and
 * serves the sidebar. Owns:
 *  - the agent runtime, workspace, tasks, confirmations, provider
 *  - message persistence (IndexedDB)
 *  - settings and provider (re)creation
 *  - dev-event buffering for the debug view
 *  - action history + activity log
 */

import type {
  ActionLogEntry,
  AgentRuntimeState,
  AppSettings,
  ChatMessageRecord,
  ConfirmationRequest,
  ConversationRecord,
  DevEvent,
  LLMUsage,
  TokenUsageMetrics,
  ToolActivityRecord,
  Workspace,
} from "@/shared/types";
import type { BootstrapPayload } from "@/shared/protocol";
import type { BackgroundEvent } from "@/shared/events";
import type { BrowserGateway } from "@/shared/browserGateway";
import type { MemoryStore } from "@/memory/MemoryStore";
import type { SettingsRepository } from "@/settings/SettingsRepository";
import type { WorkspaceManager } from "@/workspace/WorkspaceManager";
import { AgentRuntime } from "@/agent/AgentRuntime";
import { TaskManager } from "@/agent/TaskManager";
import { ConfirmationManager } from "@/agent/ConfirmationManager";
import { createProvider } from "@/providers/registry";
import type { LLMProvider } from "@/providers/LLMProvider";
import { createToolRegistry, type ToolRegistry } from "@/tools/index";
import { newId } from "@/shared/id";
import { redact } from "@/shared/redact";

export class BackgroundOrchestrator {
  readonly confirmations: ConfirmationManager;
  private readonly tasks: TaskManager;
  private readonly registry: ToolRegistry;
  private provider: LLMProvider;
  private settings: AppSettings;
  private runtime!: AgentRuntime;
  private conversation: ConversationRecord | null = null;
  private messages: ChatMessageRecord[] = [];
  private activity: ToolActivityRecord[] = [];
  private actionLog: ActionLogEntry[] = [];
  private devEvents: DevEvent[] = [];
  private tokenUsage: TokenUsageMetrics;
  private runtimeState: AgentRuntimeState = { status: "idle", iterations: 0 };
  private listeners = new Set<(event: BackgroundEvent) => void>();

  constructor(
    private readonly store: MemoryStore,
    private readonly settingsRepo: SettingsRepository,
    private readonly workspace: WorkspaceManager,
    private readonly gateway: BrowserGateway,
    registry: ToolRegistry,
    provider: LLMProvider,
    settings: AppSettings,
  ) {
    this.tasks = new TaskManager(store);
    this.confirmations = new ConfirmationManager({ emit: (e) => this.broadcast(e) });
    this.provider = provider;
    this.settings = settings;
    this.tokenUsage = emptyTokenUsage(settings.provider.contextLimitTokens);
    this.registry = registry;
    this.runtime = this.buildRuntime(registry);
  }

  /** Creates the runtime wired to this orchestrator. */
  private buildRuntime(registry: ToolRegistry): AgentRuntime {
    return new AgentRuntime({
      provider: this.provider,
      registry,
      workspace: this.workspace,
      tasks: this.tasks,
      confirmations: this.confirmations,
      gateway: this.gateway,
      settings: this.settings,
      emit: (e) => this.broadcast(e),
      emitDev: (e) => this.pushDevEvent(e as DevEvent),
      persistMessage: async (msg) => {
        await this.appendMessage(msg.role, msg.content, msg.toolCallId, msg.name);
      },
      getActionHistory: () => this.actionLog.slice(),
      getPromptCacheKey: () => `browser-agent-v1:${this.conversation?.id ?? this.workspace.getWorkspace()?.conversationId ?? "session"}`,
      reportUsage: (usage, estimatedInput, estimatedOutput, contextLimit) =>
        this.recordUsage(usage, estimatedInput, estimatedOutput, contextLimit),
    });
  }

  subscribe(listener: (event: BackgroundEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Broadcasts to all sidebar listeners (public: used by the coordinator). */
  broadcast(event: BackgroundEvent): void {
    let actionEntry: ActionLogEntry | undefined;
    if (event.type === "AGENT_STATE") this.runtimeState = event.state;
    if (event.type === "ACTIVITY" || event.type === "ACTIVITY_UPDATED") {
      const idx = this.activity.findIndex((a) => a.id === event.activity.id);
      if (idx === -1) this.activity.push(event.activity);
      else this.activity[idx] = event.activity;
      if (this.activity.length > 100) this.activity.shift();
      if (event.activity.kind !== "thinking" && event.activity.status !== "running") {
        actionEntry = {
          id: event.activity.id,
          at: event.activity.finishedAt ?? event.activity.startedAt,
          tool: event.activity.tool,
          label: event.activity.label,
          status: event.activity.status,
          detail: event.activity.detail,
          tabId: event.activity.tabId,
        };
        const logIndex = this.actionLog.findIndex((entry) => entry.id === actionEntry!.id);
        if (logIndex === -1) this.actionLog.push(actionEntry);
        else this.actionLog[logIndex] = actionEntry;
        if (this.actionLog.length > 200) this.actionLog.shift();
      }
    }
    for (const l of this.listeners) l(event);
    if (actionEntry) {
      for (const l of this.listeners) l({ type: "ACTION_LOG", entry: actionEntry });
    }
  }

  private pushDevEvent(event: DevEvent): void {
    this.devEvents.push(event);
    if (this.devEvents.length > 500) this.devEvents.shift();
    if (this.settings.devMode) this.broadcast({ type: "DEV_EVENT", event });
  }

  // -------------------------------------------------------------------------
  // Bootstrap / lifecycle
  // -------------------------------------------------------------------------

  async init(): Promise<void> {
    await this.workspace.load();
    const convId = this.workspace.getWorkspace()?.conversationId;
    if (convId) {
      this.conversation = await this.store.loadConversation(convId);
      this.messages = await this.store.loadMessages(convId);
      this.tokenUsage = normalizeTokenUsage(this.conversation?.tokenUsage, this.settings.provider.contextLimitTokens);
      this.runtime.setConversation(this.toLLMMessages(this.messages));
    }
  }

  async ensureConversation(): Promise<ConversationRecord> {
    if (this.conversation) return this.conversation;
    const ws = this.workspace.getWorkspace();
    const conv: ConversationRecord = {
      id: ws?.conversationId ?? newId("conv"),
      title: "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageIds: [],
      tokenUsage: { ...this.tokenUsage },
    };
    this.conversation = conv;
    await this.store.saveConversation(conv);
    return conv;
  }

  async bootstrap(): Promise<BootstrapPayload> {
    const conv = await this.ensureConversation();
    const pending = this.confirmations.pendingRequest;
    const active = await this.gateway.getActiveTab();
    return {
      settings: this.settings,
      runtimeState: this.runtimeState,
      conversation: conv,
      messages: this.messages,
      workspace: this.workspace.getWorkspace(),
      actionLog: this.actionLog.slice(-100),
      activity: this.activity.slice(-50),
      pendingConfirmation: pending,
      hasSiteAccess: await this.gateway.hasHostAccess(active?.url ?? "https://example.com"),
      activeTabId: active?.id,
      tokenUsage: { ...this.tokenUsage },
    };
  }

  async updateSettings(settings: AppSettings): Promise<void> {
    const activeConversation = this.runtime.getConversation();
    this.settings = settings;
    this.tokenUsage = { ...this.tokenUsage, contextLimitTokens: settings.provider.contextLimitTokens };
    await this.settingsRepo.save(settings);
    this.provider = createProvider(settings.provider);
    this.runtime = this.buildRuntime(this.registry);
    this.runtime.setConversation(activeConversation);
    this.broadcast({ type: "AGENT_STATE", state: this.runtimeState });
    this.broadcast({ type: "TOKEN_USAGE_UPDATED", usage: { ...this.tokenUsage } });
  }

  getSettings(): AppSettings {
    return this.settings;
  }

  /** Lists models from the configured provider's /models endpoint. */
  async listModels(): Promise<string[]> {
    if (!this.provider.listModels) return [];
    return this.provider.listModels();
  }

  // -------------------------------------------------------------------------
  // Workspace operations (sidebar-driven)
  // -------------------------------------------------------------------------

  getWorkspace() {
    return this.workspace.getWorkspace();
  }

  broadcastWorkspace(ws: Workspace): void {
    this.broadcast({ type: "WORKSPACE_CHANGED", workspace: ws });
  }

  async newWorkspace(name?: string): Promise<Workspace> {
    const ws = await this.workspace.newWorkspace(name);
    this.messages = [];
    this.resetTokenUsage();
    this.runtime.setConversation([]);
    return ws;
  }

  /** Binds the workspace conversation id into the current conversation. */
  async bindWorkspace(ws: Workspace): Promise<void> {
    const conv = await this.ensureConversation();
    ws.conversationId = conv.id;
    await this.store.saveWorkspace(ws);
    this.broadcast({ type: "WORKSPACE_CHANGED", workspace: ws });
  }

  async workspaceAddTab(tabId: number, url: string, title: string, pinned: boolean): Promise<void> {
    await this.workspace.addTab(tabId, { url, title }, pinned);
  }

  async workspaceRemoveTab(tabId: number): Promise<void> {
    await this.workspace.removeTab(tabId, { keepFactsAsMemory: true });
  }

  async workspaceClear(): Promise<void> {
    await this.workspace.clearWorkspace();
  }

  async workspacePinTab(tabId: number, pinned: boolean): Promise<void> {
    await this.workspace.setTabPinned(tabId, pinned);
  }

  // -------------------------------------------------------------------------
  // Conversation
  // -------------------------------------------------------------------------

  async sendUserMessage(text: string): Promise<{ ok: boolean; error?: string }> {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, error: "Empty message" };
    try {
      await this.ensureConversation();
      const result = await this.runtime.run(trimmed);
      return { ok: result.status !== "failed", error: result.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  stopAgent(): void {
    this.runtime.stop();
  }

  private async appendMessage(role: ChatMessageRecord["role"], content: string, toolCallId?: string, name?: string): Promise<void> {
    const conv = await this.ensureConversation();
    const msg: ChatMessageRecord = {
      id: newId("msg"),
      role,
      content,
      toolCallId,
      name,
      createdAt: Date.now(),
      conversationId: conv.id,
    };
    this.messages.push(msg);
    conv.messageIds.push(msg.id);
    conv.updatedAt = Date.now();
    await this.store.saveMessage(msg);
    await this.store.saveConversation(conv);
    this.broadcast({ type: "MESSAGE_ADDED", message: msg });
  }

  async newConversation(): Promise<void> {
    const ws = this.workspace.getWorkspace();
    const conv: ConversationRecord = {
      id: newId("conv"),
      title: "New conversation",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageIds: [],
      tokenUsage: emptyTokenUsage(this.settings.provider.contextLimitTokens),
    };
    this.conversation = conv;
    this.messages = [];
    this.activity = [];
    this.actionLog = [];
    this.tokenUsage = emptyTokenUsage(this.settings.provider.contextLimitTokens);
    this.runtime.setConversation([]);
    await this.store.saveConversation(conv);
    if (ws) {
      ws.conversationId = conv.id;
      await this.store.saveWorkspace(ws);
    }
    this.broadcast({ type: "CONVERSATION_RESET", conversationId: conv.id });
    this.broadcast({ type: "TOKEN_USAGE_UPDATED", usage: { ...this.tokenUsage } });
  }

  async clearConversation(): Promise<void> {
    const conv = this.conversation;
    if (!conv) return;
    await this.store.clearConversationMessages(conv.id);
    this.messages = [];
    this.activity = [];
    this.actionLog = [];
    this.resetTokenUsage();
    this.runtime.setConversation([]);
    conv.messageIds = [];
    conv.tokenUsage = { ...this.tokenUsage };
    conv.updatedAt = Date.now();
    await this.store.saveConversation(conv);
    this.broadcast({ type: "CONVERSATION_RESET", conversationId: conv.id });
  }

  // -------------------------------------------------------------------------
  // Memory maintenance
  // -------------------------------------------------------------------------

  async deleteAllLocalData(): Promise<void> {
    await this.store.clearAll();
    this.messages = [];
    this.activity = [];
    this.actionLog = [];
    this.devEvents = [];
    this.resetTokenUsage();
    this.conversation = null;
    this.runtime.setConversation([]);
    await this.workspace.newWorkspace();
    await this.ensureConversation();
  }

  // -------------------------------------------------------------------------
  // Logs & dev
  // -------------------------------------------------------------------------

  getDevEvents(): DevEvent[] {
    return this.devEvents.slice(-200).map((e) => redact(e) as DevEvent);
  }

  getActionLog(): ActionLogEntry[] {
    return this.actionLog.slice(-100);
  }

  getActivity(): ToolActivityRecord[] {
    return this.activity.slice(-50);
  }

  // -------------------------------------------------------------------------

  private toLLMMessages(records: ChatMessageRecord[]): Parameters<AgentRuntime["setConversation"]>[0] {
    return records.map((r) => ({
      role: r.role,
      content: r.content,
      toolCallId: r.toolCallId,
      name: r.name,
    }));
  }

  private async recordUsage(
    usage: LLMUsage | undefined,
    estimatedInputTokens: number,
    estimatedOutputTokens: number,
    contextLimitTokens: number,
  ): Promise<void> {
    const inputTokens = usage?.inputTokens ?? estimatedInputTokens;
    const outputTokens = usage?.outputTokens ?? estimatedOutputTokens;
    const cacheReported = usage?.cachedInputTokens !== undefined
      || usage?.cacheMissTokens !== undefined
      || usage?.cacheWriteTokens !== undefined;
    const cachedInputTokens = usage?.cachedInputTokens ?? 0;
    const cacheMissTokens = usage?.cacheMissTokens
      ?? (cacheReported ? Math.max(0, inputTokens - cachedInputTokens) : 0);

    this.tokenUsage = {
      inputTokens: this.tokenUsage.inputTokens + inputTokens,
      outputTokens: this.tokenUsage.outputTokens + outputTokens,
      cachedInputTokens: this.tokenUsage.cachedInputTokens + cachedInputTokens,
      cacheMissTokens: this.tokenUsage.cacheMissTokens + cacheMissTokens,
      cacheWriteTokens: this.tokenUsage.cacheWriteTokens + (usage?.cacheWriteTokens ?? 0),
      requestCount: this.tokenUsage.requestCount + 1,
      cacheReportingRequests: this.tokenUsage.cacheReportingRequests + (cacheReported ? 1 : 0),
      estimatedRequests: this.tokenUsage.estimatedRequests + (usage?.inputTokens === undefined || usage?.outputTokens === undefined ? 1 : 0),
      lastContextTokens: inputTokens,
      contextLimitTokens: contextLimitTokens || this.tokenUsage.contextLimitTokens,
    };

    if (this.conversation) {
      this.conversation.tokenUsage = { ...this.tokenUsage };
      this.conversation.updatedAt = Date.now();
      await this.store.saveConversation(this.conversation);
    }
    this.broadcast({ type: "TOKEN_USAGE_UPDATED", usage: { ...this.tokenUsage } });
  }

  private resetTokenUsage(): void {
    this.tokenUsage = emptyTokenUsage(this.settings.provider.contextLimitTokens);
    this.broadcast({ type: "TOKEN_USAGE_UPDATED", usage: { ...this.tokenUsage } });
  }
}

function emptyTokenUsage(contextLimitTokens: number): TokenUsageMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    requestCount: 0,
    cacheReportingRequests: 0,
    estimatedRequests: 0,
    lastContextTokens: 0,
    contextLimitTokens,
  };
}

function normalizeTokenUsage(usage: TokenUsageMetrics | undefined, contextLimitTokens: number): TokenUsageMetrics {
  return { ...emptyTokenUsage(contextLimitTokens), ...(usage ?? {}), contextLimitTokens };
}

// Re-export helper so index.ts can build the registry once.
export { createToolRegistry };
export type { ConfirmationRequest };
