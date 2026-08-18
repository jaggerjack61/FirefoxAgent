/**
 * AgentRuntime: the iterative agent loop.
 *
 *   user request → build context → LLM → validate tool calls →
 *   confirmation policy → execute → observation → LLM → ... → final
 *
 * Hard limits (max iterations, timeout, max tabs) are enforced here.
 * The LLM decides WHAT to do; trusted code decides what it is ALLOWED to
 * do and performs it.
 */

import type { ActionLogEntry, AppSettings, LLMMessage, LLMResponse, ToolCall } from "@/shared/types";
import type { LLMProvider } from "@/providers/LLMProvider";
import type { ToolRegistry } from "@/tools/ToolRegistry";
import type { WorkspaceManager } from "@/workspace/WorkspaceManager";
import type { TaskManager } from "./TaskManager";
import type { ConfirmationManager } from "./ConfirmationManager";
import type { BrowserGateway } from "@/shared/browserGateway";
import { ToolError } from "@/shared/errors";
import { evaluateConfirmation, isReadOnlyTool, type ConfirmationContext } from "@/security/confirmation";
import { buildSystemPrompt, buildConversationLayer, formatToolObservation, renderActiveTabContext } from "./ContextBuilder";
import { TokenBudget } from "./TokenBudget";
import { newId } from "@/shared/id";
import { estimateTokens } from "@/shared/tokens";
import { parseStructuredToolOutput, structuredOutputInstruction } from "@/providers/OpenAICompatibleProvider";
import type { BackgroundEvent } from "@/shared/events";
import { derivePageFacts, derivePageSummary } from "@/workspace/pageNotes";

export interface AgentRuntimeDeps {
  provider: LLMProvider;
  registry: ToolRegistry;
  workspace: WorkspaceManager;
  tasks: TaskManager;
  confirmations: ConfirmationManager;
  gateway: BrowserGateway;
  settings: AppSettings;
  emit: (event: BackgroundEvent) => void;
  emitDev: (event: unknown) => void;
  /** Persists a chat message to IndexedDB (provided by the orchestrator). */
  persistMessage: (msg: { role: LLMMessage["role"]; content: string; toolCallId?: string; name?: string }) => Promise<void>;
  getActionHistory: () => ActionLogEntry[];
}

export interface RunResult {
  finalText: string;
  iterations: number;
  status: "completed" | "stopped" | "failed" | "awaiting_user";
  error?: string;
}

/** Tools whose target tab is auto-added to the workspace (spec §27). */
const AUTO_ADD_TOOLS = new Set([
  "open_tab", "navigate", "search_web", "switch_tab", "summarize_tab",
  "get_page_text", "get_visible_text", "get_page_structure", "get_forms", "find_text", "get_page_snapshot",
  "extract_table", "extract_list", "extract_links", "extract_structured_content",
  "click_element", "focus_element", "type_text", "clear_input", "select_option", "set_checkbox",
]);

/** Read results that can be compacted into workspace notes without another LLM call. */
const AUTO_SUMMARIZE_TOOLS = new Set([
  "get_page_text", "get_visible_text", "get_page_structure", "find_text", "get_page_snapshot",
  "extract_table", "extract_list", "extract_links", "extract_structured_content",
]);

const CURRENT_PAGE_TOOLS = new Set([
  "navigate", "search_web", "download_file", "reload_tab", "go_back", "go_forward", "close_tab",
  "get_page_text", "get_visible_text", "get_page_structure", "get_forms", "find_text", "get_page_snapshot",
  "click_element", "focus_element", "type_text", "clear_input", "select_option", "set_checkbox",
  "scroll", "scroll_to_element", "hover_element", "press_key",
  "extract_table", "extract_list", "extract_links", "extract_structured_content",
]);

const CROSS_TAB_TOOLS = new Set([
  "list_tabs", "switch_tab", "open_tab", "close_tabs", "duplicate_tab", "restore_closed_tab",
  "summarize_tab", "save_tab_notes",
]);

const MEMORY_TOOLS = new Set(["clear_memory", "summarize_tab", "save_tab_notes"]);
const UNDO_TOOLS = new Set(["undo_last_action"]);
const HISTORY_TOOLS = new Set(["get_action_history"]);

/** Tools that inherently inspect, create, or select a non-current page. */
const CROSS_PAGE_ONLY_TOOLS = new Set([
  "list_tabs", "switch_tab", "open_tab", "close_tabs", "duplicate_tab", "restore_closed_tab",
]);

export class AgentRuntime {
  private abortController: AbortController | null = null;
  private conversation: LLMMessage[] = [];

  constructor(private readonly deps: AgentRuntimeDeps) {}

  private emit(event: BackgroundEvent): void {
    this.deps.emit(event);
  }

  private emitDev(event: unknown): void {
    this.deps.emitDev(event);
  }

  /** Seeds runtime with persisted conversation messages. */
  setConversation(messages: LLMMessage[]): void {
    this.conversation = messages;
  }

  getConversation(): LLMMessage[] {
    return this.conversation;
  }

  stop(reason = "Stopped by user"): void {
    this.abortController?.abort();
    this.deps.confirmations.cancelAll();
    this.emit({ type: "AGENT_STATE", state: { status: "stopped", iterations: 0, currentActivity: reason } });
  }

  async run(userText: string): Promise<RunResult> {
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const startedAt = Date.now();
    const settings = this.deps.settings;
    const limits = settings.limits;

    this.conversation.push({ role: "user", content: userText });
    await this.deps.persistMessage({ role: "user", content: userText });

    this.emit({ type: "AGENT_STATE", state: { status: "running", iterations: 0, currentActivity: "Planning…" } });
    const task = await this.deps.tasks.start(userText);
    await this.deps.workspace.setActiveTask(task.id);

    let iterations = 0;
    let actions = 0;
    let finalText = "";
    let status: RunResult["status"] = "completed";
    let lastError: string | undefined;

    try {
      for (;;) {
        if (signal.aborted) {
          status = "stopped";
          finalText = "Task stopped.";
          break;
        }
        if (Date.now() - startedAt > limits.taskTimeoutMs) {
          throw new ToolError("TASK_TIMEOUT", `Task exceeded the ${Math.round(limits.taskTimeoutMs / 60000)} minute timeout.`);
        }
        const forceFinal = actions >= limits.maxActionsPerTask;
        iterations += 1;
        this.emit({ type: "AGENT_STATE", state: { status: "running", iterations, currentActivity: "Thinking…" } });

        const response = await this.askModelWithProgress(signal, settings, iterations, forceFinal);
        if (response.toolCalls.length === 0) {
          finalText = response.content ?? "";
          if (finalText) {
            this.conversation.push({ role: "assistant", content: finalText });
            await this.deps.persistMessage({ role: "assistant", content: finalText });
          }
          break;
        }

        const remaining = Math.max(0, limits.maxActionsPerTask - actions);
        const allowedCalls = response.toolCalls.slice(0, remaining);
        const overflowCalls = response.toolCalls.slice(remaining);
        actions += allowedCalls.length;

        let executed: Array<{ call: ToolCall; observation: string }>;
        const canRunInParallel = this.deps.provider.capabilities().parallelTools
          && allowedCalls.length > 1
          && allowedCalls.every((call) => isReadOnlyTool(call.name));
        if (canRunInParallel) {
          const observations = await Promise.all(allowedCalls.map((call) => this.executeToolCall(call, signal, settings)));
          executed = allowedCalls.map((call, index) => ({ call, observation: observations[index] }));
        } else {
          executed = [];
          for (const call of allowedCalls) {
            if (signal.aborted) break;
            executed.push({ call, observation: await this.executeToolCall(call, signal, settings) });
          }
        }

        executed.push(...overflowCalls.map((call) => ({
          call,
          observation: formatToolObservation(call.name, null, {
            code: "MAX_ITERATIONS",
            message: `Skipped because the ${limits.maxActionsPerTask}-action limit was reached.`,
            suggestedAction: "Answer with the information already gathered.",
          }),
        })));
        if (executed.length) {
          // Preserve one assistant turn for the complete tool-call batch.
          // Splitting parallel calls into separate assistant messages produces
          // invalid history for providers such as DeepSeek.
          this.conversation.push(
            { role: "assistant", content: response.content, toolCalls: executed.map(({ call }) => call) },
            ...executed.map(({ call, observation }) => ({
              role: "tool" as const,
              content: observation,
              toolCallId: call.id,
              name: call.name,
            })),
          );
        }

        const taskState = this.deps.tasks.getTask();
        if (taskState?.status === "awaiting_user") {
          status = "awaiting_user";
          finalText = "Waiting for your decision.";
          break;
        }
      }
    } catch (err) {
      status = err instanceof ToolError && err.code === "AGENT_STOPPED" ? "stopped" : "failed";
      lastError = err instanceof Error ? err.message : String(err);
      if (status === "stopped") lastError = "Stopped by user.";
      finalText = `⚠️ ${lastError}`;
      this.conversation.push({ role: "assistant", content: finalText });
      await this.deps.persistMessage({ role: "assistant", content: finalText });
      await this.deps.tasks.setStatus(status === "stopped" ? "stopped" : "failed", lastError);
    } finally {
      this.abortController = null;
      // Always clear partial streamed text, including provider failures.
      this.emit({ type: "STREAM_DONE" });
      this.emit({ type: "AGENT_STATE", state: { status: "idle", iterations, currentActivity: undefined } });
    }

    if (status === "completed" || status === "awaiting_user") {
      await this.deps.tasks.setStatus(status);
      await this.deps.workspace.setActiveTask(undefined);
    }
    return { finalText, iterations, status, error: lastError };
  }

  // -------------------------------------------------------------------------
  // Model call + context construction
  // -------------------------------------------------------------------------

  private async askModelWithProgress(signal: AbortSignal, settings: AppSettings, iteration: number, forceFinal = false): Promise<LLMResponse> {
    const activityId = newId("think");
    const startedAt = Date.now();
    this.emitActivity(activityId, "running", "agent", `Planning step ${iteration}`, startedAt, undefined, "thinking");
    try {
      const response = await this.askModel(signal, settings, forceFinal);
      const detail = response.toolCalls.length > 0
        ? `Next action${response.toolCalls.length === 1 ? "" : "s"}: ${response.toolCalls.map((call) => call.name).join(", ")}`
        : "Prepared a response";
      this.emitActivity(activityId, "ok", "agent", `Planned step ${iteration}`, startedAt, detail, "thinking");
      return response;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.emitActivity(activityId, "error", "agent", `Planning step ${iteration} failed`, startedAt, detail, "thinking");
      throw err;
    }
  }

  private async askModel(signal: AbortSignal, settings: AppSettings, forceFinal = false): Promise<LLMResponse> {
    const context = await this.buildContext(settings);
    const started = Date.now();

    const provider = this.deps.provider;
    const useTools = !forceFinal && provider.supportsToolCalling() && context.toolDefs.length > 0;
    const fallbackMode = !forceFinal && !useTools;
    const finalInstruction: LLMMessage = {
      role: "user",
      content: "The browser-action budget is exhausted. Do not request more tools; answer the user now from the information already gathered.",
    };
    const request: Parameters<LLMProvider["send"]>[0] = {
      messages: forceFinal
        ? [...context.messages, finalInstruction]
        : useTools ? context.messages : [...context.messages, { role: "user", content: structuredOutputInstruction() }],
      tools: useTools ? context.toolDefs : undefined,
      jsonMode: fallbackMode,
      temperature: settings.provider.temperature,
      maxOutputTokens: settings.provider.maxOutputTokens,
    };

    this.deps.emitDev({
      kind: "llm_request",
      ts: Date.now(),
      messageCount: request.messages.length,
      estimatedTokens: context.totalTokens,
      contextLayers: context.layerTokens,
      model: settings.provider.model,
    });

    const rawResponse = await provider.send(request, {
      signal,
      onStream: (event) => {
        if (event.kind === "text_delta") this.emit({ type: "STREAM_DELTA", text: event.text });
        if (event.kind === "done") this.emit({ type: "STREAM_DONE" });
      },
    });
    const fallback = !fallbackMode || !rawResponse.content ? null : parseStructuredToolOutput(rawResponse.content);
    const response: LLMResponse = forceFinal
      ? { ...rawResponse, content: rawResponse.content ?? "I reached the browser-action limit before I could finish.", toolCalls: [], finishReason: "stop" }
      : fallback
      ? {
          ...rawResponse,
          content: fallback.reply ?? null,
          toolCalls: fallback.toolCalls ?? [],
          finishReason: fallback.toolCalls?.length ? "tool_calls" : rawResponse.finishReason,
        }
      : rawResponse;

    this.deps.emitDev({
      kind: "llm_response",
      ts: Date.now(),
      latencyMs: Date.now() - started,
      finishReason: response.finishReason,
      estimatedTokens: estimateTokens(response.content ?? ""),
      toolCalls: response.toolCalls.length,
      iteration: 1,
    });

    return response;
  }

  private async buildContext(settings: AppSettings): Promise<{
    messages: LLMMessage[];
    toolDefs: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
    totalTokens: number;
    layerTokens: Record<string, number>;
  }> {
    const selectedToolNames = this.selectToolNames(this.deps.tasks.getTask()?.goal ?? "");
    const toolDefs = this.deps.registry.llmToolDefs(selectedToolNames);
    const nativeTools = this.deps.provider.supportsToolCalling();
    const toolDescriptions = nativeTools
      ? "Tool names, descriptions, and parameter schemas are supplied through native function calling."
      : this.deps.registry.toolDescriptions(selectedToolNames, true);
    const nativeToolSchemaText = nativeTools ? JSON.stringify(toolDefs) : "";
    const systemPrompt = buildSystemPrompt({
      settings,
      mode: settings.mode,
      toolDescriptions,
      maxActions: settings.limits.maxActionsPerTask,
    });

    const taskBlock = this.deps.tasks.renderForModel();
    const memoryBlock = await this.renderMemory(settings);
    let workspaceBlock = [this.deps.workspace.renderForModel(settings.limits.maxTabsInspected), memoryBlock].filter(Boolean).join("\n\n");
    let activeTabBlock = await this.renderActiveTab(settings);

    const budget = new TokenBudget(settings);
    const compression = budget.planCompression({
      systemPrompt,
      conversation: this.conversation,
      workspaceText: workspaceBlock,
      activeTabText: activeTabBlock,
      toolDescriptions: nativeToolSchemaText,
    });

    if (compression.factsOnlyWorkspace) {
      workspaceBlock = [
        this.deps.workspace.renderForModel(settings.limits.maxTabsInspected, { factsOnly: true }),
        memoryBlock,
      ].filter(Boolean).join("\n\n");
    }
    if (compression.dropActiveTabText) activeTabBlock = stripActiveTabText(activeTabBlock);

    // Rebuild the conversation layer with compression applied.
    const conv = buildConversationLayer(this.conversation, {
      keepRecent: compression.compressConversation ? Math.max(2, Math.floor(settings.compression.keepRecentMessages / 2)) : settings.compression.keepRecentMessages,
      summarizeThreshold: compression.compressConversation ? 6 : settings.compression.summarizeThreshold,
    });

    const messages: LLMMessage[] = [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          "CURRENT TASK CONTEXT",
          taskBlock,
          workspaceBlock,
          activeTabBlock,
          "Now respond to the user's latest request.",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...conv.messages,
    ];

    const layerTokens = {
      system: estimateTokens(systemPrompt),
      conversation: conv.totalTokens,
      workspace: estimateTokens(workspaceBlock),
      activeTab: estimateTokens(activeTabBlock),
      tools: estimateTokens(nativeToolSchemaText),
    };
    const totalTokens = layerTokens.system + layerTokens.conversation + layerTokens.workspace + layerTokens.activeTab + layerTokens.tools;

    this.deps.emitDev({
      kind: "context",
      ts: Date.now(),
      layers: layerTokens,
      totalTokens,
      compressed: compression.compressConversation || compression.dropActiveTabText || compression.factsOnlyWorkspace,
    });

    return { messages, toolDefs, totalTokens, layerTokens };
  }

  private selectToolNames(goal: string): Set<string> {
    const selected = new Set(CURRENT_PAGE_TOOLS);
    if (explicitlyTargetsOtherPage(goal)) {
      for (const name of CROSS_TAB_TOOLS) selected.add(name);
    }
    if (/\b(?:remember|memory|memorized|saved|forget|previous\s+session)\b/i.test(goal)) {
      for (const name of MEMORY_TOOLS) selected.add(name);
    }
    if (/\b(?:undo|restore|reopen|previous\s+value)\b/i.test(goal)) {
      for (const name of UNDO_TOOLS) selected.add(name);
    }
    if (/\b(?:action\s+history|actions?\s+(?:did|taken|so\s+far)|what\s+did\s+you\s+do)\b/i.test(goal)) {
      for (const name of HISTORY_TOOLS) selected.add(name);
    }
    return selected;
  }

  private async renderMemory(settings: AppSettings): Promise<string> {
    if (!settings.memory.enabled) return "";
    try {
      const facts = await this.deps.workspace.getStorage().loadFacts();
      const recent = facts.slice(-30);
      if (!recent.length) return "LONG-TERM MEMORY: (no remembered facts)";
      return [
        "LONG-TERM MEMORY:",
        ...recent.map((fact) => `- ${fact.text}${fact.stale ? " (historical)" : ""}`),
      ].join("\n");
    } catch {
      return "LONG-TERM MEMORY: (unavailable)";
    }
  }

  private async renderActiveTab(settings: AppSettings): Promise<string> {
    try {
      const active = await this.deps.gateway.getActiveTab();
      if (!active || !active.url || /^(about|moz-extension|chrome|file|data):/.test(active.url)) {
        return "ACTIVE TAB: (no web page)";
      }
      if (!settings.privacy.allowActivePageContent) {
        return `ACTIVE TAB:\nTitle: ${active.title}\nURL: ${active.url}\n(page content sharing disabled)`;
      }
      const snap = await this.deps.gateway.getSnapshot(active.id, {
        maxTextChars: settings.limits.maxPageTextChars,
        maxElements: settings.limits.maxSnapshotElements,
        maxLinks: 0,
        includeValues: false,
        includeFrames: true,
      });
      return renderActiveTabContext({
        tabId: active.id,
        url: snap.url,
        title: snap.title,
        elements: snap.elements
          .filter((e) => e.visible && (e.clickable !== true || e.actionable !== false))
          .map((e) => ({
            id: e.id,
            role: e.role,
            name: e.name,
            enabled: e.enabled,
            clickable: e.clickable,
            actionable: e.actionable,
          })),
        text: snap.text,
        headings: snap.headings,
        networkIdle: snap.networkIdle,
      });
    } catch (err) {
      if (err instanceof ToolError && err.code === "NAVIGATION_TIMEOUT") {
        const active = await this.deps.gateway.getActiveTab().catch(() => null);
        return [
          "ACTIVE TAB:",
          active ? `Tab ID: ${active.id}` : "",
          active?.title ? `Title: ${active.title}` : "",
          active?.url ? `URL: ${active.url}` : "",
          "Status: loading or waiting for page API responses (reads and interactions wait for network idle automatically)",
        ].filter(Boolean).join("\n");
      }
      return "ACTIVE TAB: (cannot inspect — content script unavailable or permission missing)";
    }
  }

  // -------------------------------------------------------------------------
  // Tool execution with validation + confirmation enforcement
  // -------------------------------------------------------------------------

  private async executeToolCall(call: ToolCall, signal: AbortSignal, settings: AppSettings): Promise<string> {
    const t0 = Date.now();
    const activityId = newId("act");
    const label = this.describeCall(call);
    this.emitActivity(activityId, "running", call.name, label, t0);

    try {
      if (call.name === "reload_tab" && !this.reloadIsJustified()) {
        throw new ToolError("ACTION_NOT_ALLOWED", "Skipped reload because the current page snapshot is already available.", {
          suggestedAction: "Inspect the current snapshot first. Reload only if the user requested it or a prior observation says the page is stale or unavailable.",
        });
      }
      // 1. Validate against the schema (never trust model output).
      const validated = this.deps.registry.validateCall(call.name, call.arguments) as {
        tabId?: number;
        tabIds?: number[];
        elementId?: string;
        key?: string;
        url?: string;
        newTab?: boolean;
        openInBackground?: boolean;
      };

      // Schemas accept explicit tab ids for real cross-tab tasks, but the
      // trusted runtime still prevents the model from inventing that scope.
      await this.enforcePageScope(call.name, validated);

      // 2. Confirmation policy — enforced outside the model layer.
      await this.checkConfirmation(call, validated, settings);

      // 3. Execute.
      const fallbackTabId = AUTO_ADD_TOOLS.has(call.name) && validated.tabId === undefined
        ? (await this.deps.gateway.getActiveTab())?.id
        : undefined;
      const output = await this.deps.registry.executeCall(call.name, validated, {
        gateway: this.deps.gateway,
        workspace: this.deps.workspace,
        settings,
        signal,
        dev: this.deps.emitDev,
        actionHistory: this.deps.getActionHistory,
      });

      // 4. Workspace bookkeeping: tabs the agent opens/inspects join the workspace.
      await this.autoSummarizeInspection(call, output, fallbackTabId, settings);
      await this.autoAddTab(call, output as { tabId?: number }, fallbackTabId);

      const obs = formatToolObservation(call.name, output);
      this.emitDev({
        kind: "tool_call",
        ts: Date.now(),
        tool: call.name,
        input: call.arguments,
        output: truncateDev(output),
        ok: true,
        latencyMs: Date.now() - t0,
      });
      this.emitActivity(activityId, "ok", call.name, label, t0);
      await this.deps.tasks.addCompletedStep(label);
      return obs;
    } catch (err) {
      const toolErr = err instanceof ToolError ? err : new ToolError("INTERNAL_ERROR", err instanceof Error ? err.message : String(err));
      this.emitDev({ kind: "tool_call", ts: Date.now(), tool: call.name, input: call.arguments, ok: false, latencyMs: Date.now() - t0 });
      this.emitDev({ kind: "error", ts: Date.now(), code: toolErr.code, message: toolErr.message });
      this.emitActivity(activityId, "error", call.name, label, t0, toolErr.message);
      return formatToolObservation(call.name, null, {
        code: toolErr.code,
        message: toolErr.message,
        suggestedAction: toolErr.suggestedAction,
      });
    }
  }

  private async autoAddTab(call: ToolCall, output: { tabId?: number }, fallbackTabId?: number): Promise<void> {
    if (!AUTO_ADD_TOOLS.has(call.name)) return;
    const tabId = output.tabId ?? this.tabIdOf(call) ?? fallbackTabId;
    if (tabId === undefined) return;
    if (!this.deps.workspace.getTab(tabId)) {
      const limit = this.deps.settings.limits.maxTabsInspected;
      const ws = this.deps.workspace.getWorkspace();
      if (ws && ws.tabs.length >= limit) return;
      const meta = await this.deps.gateway.getTab(tabId);
      if (!meta) return;
      await this.deps.workspace.addTab(tabId, { url: meta.url, title: meta.title });
    }
    await this.deps.tasks.addReferencedTab(tabId);
  }

  private async checkConfirmation(
    call: ToolCall,
    input: { tabId?: number; tabIds?: number[]; elementId?: string; key?: string; url?: string },
    settings: AppSettings,
  ): Promise<void> {
    const active = await this.deps.gateway.getActiveTab();
    const targetTabId = input.tabId ?? active?.id;
    const targetTab = targetTabId === undefined ? null : await this.deps.gateway.getTab(targetTabId);
    const ctx: ConfirmationContext = {
      mode: settings.mode,
      pageUrl: targetTab?.url ?? active?.url,
      targetUrl: input.url,
      tabCount: input.tabIds?.length ?? 1,
    };
    if (input.elementId && targetTabId !== undefined) {
      const desc = await this.deps.gateway.describeElement(targetTabId, input.elementId);
      if (desc) {
        ctx.elementName = desc.name;
        ctx.sensitiveField = desc.type === "password";
        ctx.submittingForm = desc.inForm && (desc.type === "submit" || (call.name === "press_key" && input.key === "Enter"));
      }
    }
    const policyDecision = evaluateConfirmation(call.name, ctx);
    const declaredConfirmation = settings.mode !== "yolo"
      && this.deps.registry.get(call.name)?.tool.requiresConfirmation === true;
    const decision = declaredConfirmation && !policyDecision.required
      ? { required: true, highRisk: false, reason: "This tool always requires explicit approval." }
      : policyDecision;
    if (!decision.required) return;

    const description = this.describeCall(call);
    const details = [`Tool: ${call.name}`, `Action: ${description}`, decision.reason ?? ""].join("\n");
    this.emitDev({ kind: "confirmation", ts: Date.now(), tool: call.name, approved: false, highRisk: decision.highRisk });
    await this.deps.tasks.setStatus("awaiting_user");
    const approved = await this.deps.confirmations.request(call.name, description, details, {
      highRisk: decision.highRisk,
      tabId: targetTabId,
    });
    this.emitDev({ kind: "confirmation", ts: Date.now(), tool: call.name, approved, highRisk: decision.highRisk });
    // Whatever the user decided, the task resumes: on denial the loop
    // continues so the model can react to the structured CONFIRMATION_DENIED
    // observation. (A pending confirmation still blocks the loop.)
    await this.deps.tasks.setStatus("running");
    if (!approved) {
      throw new ToolError("CONFIRMATION_DENIED", `Action "${description}" was not approved.`, {
        suggestedAction: "Ask the user how to proceed.",
      });
    }
  }

  private async autoSummarizeInspection(
    call: ToolCall,
    output: unknown,
    fallbackTabId: number | undefined,
    settings: AppSettings,
  ): Promise<void> {
    if (!settings.memory.enabled || !settings.memory.autoSummarizePages || !AUTO_SUMMARIZE_TOOLS.has(call.name)) return;
    const outputTabId = isRecord(output) && typeof output.tabId === "number" ? output.tabId : undefined;
    const tabId = outputTabId ?? this.tabIdOf(call) ?? fallbackTabId;
    if (tabId === undefined) return;
    const ws = this.deps.workspace.getWorkspace();
    if (!this.deps.workspace.getTab(tabId) && ws && ws.tabs.length >= settings.limits.maxTabsInspected) return;
    const tab = await this.deps.gateway.getTab(tabId);
    if (!tab) return;
    const notes = inspectionNotesFromOutput(output);
    if (!notes.text && !notes.headings.length) return;
    await this.deps.workspace.recordInspection(tabId, {
      url: tab.url,
      title: tab.title,
      summary: derivePageSummary(tab.title, notes.text, notes.headings),
      facts: derivePageFacts(notes.text),
    });
  }

  private async enforcePageScope(
    toolName: string,
    input: { tabId?: number; newTab?: boolean; openInBackground?: boolean },
  ): Promise<void> {
    const goal = this.deps.tasks.getTask()?.goal ?? "";
    if (explicitlyTargetsOtherPage(goal)) return;

    if (CROSS_PAGE_ONLY_TOOLS.has(toolName) || input.newTab || input.openInBackground) {
      throw new ToolError("ACTION_NOT_ALLOWED", "The user did not ask to use or create another page or tab.", {
        suggestedAction: "Perform the request in the current active tab instead.",
      });
    }

    if (input.tabId === undefined) return;
    const active = await this.deps.gateway.getActiveTab();
    if (!active || input.tabId !== active.id) {
      throw new ToolError("ACTION_NOT_ALLOWED", `Tab ${input.tabId} is not the current active tab.`, {
        suggestedAction: "Omit tabId so the action targets the current page.",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private describeCall(call: ToolCall): string {
    const args = call.arguments;
    const pretty = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));
    switch (call.name) {
      case "click_element":
        return `Click ${pretty(args.elementId ?? "")}`;
      case "type_text":
        return `Type into ${pretty(args.elementId ?? "")}`;
      case "open_tab":
        return `Open ${pretty(args.url ?? "")}`;
      case "navigate":
        return `Navigate to ${pretty(args.url ?? "")}`;
      case "download_file":
        return `Download ${pretty(args.filename ?? args.url ?? "")}`;
      case "switch_tab":
        return `Switch to tab ${pretty(args.tabId ?? "")}`;
      case "close_tab":
        return `Close tab ${pretty(args.tabId ?? "")}`;
      case "search_web":
        return `Search for "${pretty(args.query ?? "")}"`;
      case "get_page_snapshot":
      case "get_page_text":
        return "Read current page";
      case "summarize_tab":
        return `Read tab ${pretty(args.tabId ?? "")}`;
      case "scroll":
        return `Scroll ${pretty(args.dy ?? "")}px`;
      default:
        return call.name;
    }
  }

  private tabIdOf(call: ToolCall): number | undefined {
    const v = call.arguments.tabId;
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  }

  private reloadIsJustified(): boolean {
    const goal = this.deps.tasks.getTask()?.goal ?? "";
    if (/\b(?:reload|refresh|hard refresh)\b/i.test(goal)) return true;
    return this.conversation.slice(-8).some((message) =>
      message.role === "tool" && /CONTENT_SCRIPT_UNAVAILABLE|reload the tab|page still loading|stale/i.test(message.content ?? ""),
    );
  }

  private emitActivity(
    id: string,
    status: "running" | "ok" | "error",
    tool: string,
    label: string,
    startedAt: number,
    detail?: string,
    kind: "tool" | "thinking" = "tool",
  ): void {
    this.emit({
      type: "ACTIVITY",
      activity: {
        id,
        conversationId: this.deps.workspace.getWorkspace()?.conversationId ?? "conv",
        kind,
        tool,
        label,
        status,
        startedAt,
        ...(status === "running" ? {} : { finishedAt: Date.now() }),
        ...(detail ? { detail } : {}),
      },
    });
  }
}

function truncateDev(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, 2000);
  return value;
}

function stripActiveTabText(block: string): string {
  const marker = "\nPAGE TEXT:\n";
  const index = block.indexOf(marker);
  return index === -1 ? block : block.slice(0, index);
}

/** True only when the user's goal establishes a non-current page scope. */
function explicitlyTargetsOtherPage(goal: string): boolean {
  return /\btabs\b/i.test(goal)
    || /\bpages\b/i.test(goal)
    || /\bwindows\b/i.test(goal)
    || /\btab\s+(?:#?\d+|named\b|titled\b)/i.test(goal)
    || /\b(?:switch|change|select|go\s+to|move\s+to)\s+(?:the\s+)?tab\b/i.test(goal)
    || /\b(?:another|other|different|separate|new|next|previous)\s+(?:tab|page|window|site|website)\b/i.test(goal)
    || /\b(?:all|each|every|both|these|those|multiple|several|two|three|\d+)\s+(?:open\s+)?(?:tabs?|pages?)\b/i.test(goal)
    || /\bacross\s+(?:tabs?|pages?|sites?|websites?)\b/i.test(goal)
    || /\b(?:duplicate|reopen|restore)\b/i.test(goal)
    || /\b(?:in|to)\s+(?:a\s+)?background\b/i.test(goal);
}

function inspectionNotesFromOutput(output: unknown): { text: string; headings: string[] } {
  if (typeof output === "string") return { text: output.slice(0, 8_000), headings: [] };
  if (Array.isArray(output)) return { text: JSON.stringify(output).slice(0, 8_000), headings: [] };
  if (!isRecord(output)) return { text: "", headings: [] };

  const headings = Array.isArray(output.headings)
    ? output.headings.filter((item): item is string => typeof item === "string").slice(0, 20)
    : [];
  for (const key of ["text", "content", "markdown", "textPreview"] as const) {
    if (typeof output[key] === "string" && output[key].trim()) {
      return { text: output[key].slice(0, 8_000), headings };
    }
  }
  for (const key of ["results", "rows", "items", "links"] as const) {
    if (Array.isArray(output[key]) && output[key].length) {
      return { text: JSON.stringify(output[key]).slice(0, 8_000), headings };
    }
  }
  return { text: "", headings };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
