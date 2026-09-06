import { abortable } from "@/shared/abort";
import { pruneSupersededReads } from "@/context/observations";
import { serializeToolResult } from "@/tools/results";
import { ContextBudgetError, ContextCompiler, type TraceSegment } from "@/context/compiler";
import { IndexedDbRepository, type Repository } from "@/persistence/repository";
import {
  createProvider,
  listProviderModels as fetchProviderModels,
  persistedUsage,
  type ConversationStep,
  type ProviderRequest,
} from "@/providers";
import {
  DEFAULT_SETTINGS,
  appSettingsSchema,
  makeTokenPolicy,
  providerCapabilitiesSchema,
  providerSettingsSchema,
  type ActionIntent,
  type AgentEvent,
  type AppSettings,
  type PendingConfirmation,
  type ProviderConnection,
  type ProviderSettings,
  type RunRecord,
  type SafetyMode,
  type SourceReference,
  type ToolCall,
  type UiCommand,
} from "@/shared/schema";
import { TOKEN_LIMITS, createId, stableStringify, truncateToTokens } from "@/shared/token";
import { makeActionIntent, requiresConfirmation, type TargetDescriptor } from "@/security/policy";
import { SettingsRepository } from "@/settings/repository";
import { selectProvider, updateActiveProvider } from "@/settings/profiles";
import { TOOL_DEFINITIONS, parseToolInput } from "@/tools/definitions";
import { FirefoxGateway } from "./firefoxGateway";

type EventSink = (event: AgentEvent) => void;

interface PendingResolver {
  intent: ActionIntent;
  resolve: (approved: boolean) => void;
}

/** Abort reason for the run deadline. Node's DOMException extends Error, so a
 * dedicated class is the only reliable way to distinguish timeouts from Stop. */
class RunTimeoutError extends Error {
  constructor() {
    super("The run reached its time limit");
    this.name = "RunTimeoutError";
  }
}

export class Orchestrator {
  private readonly compiler = new ContextCompiler();
  private readonly settingsRepository = new SettingsRepository();
  private settings: AppSettings = DEFAULT_SETTINGS;
  private mode: SafetyMode = "agent";
  private eventSequence = 0;
  private abortController: AbortController | null = null;
  private currentRunId: string | null = null;
  private snapshotSequence = 0;
  private pending: PendingResolver | null = null;
  private initialized = false;

  constructor(
    private readonly repository: Repository = new IndexedDbRepository(),
    private readonly gateway = new FirefoxGateway(),
    private readonly emitEvent: EventSink = () => undefined,
  ) {}

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.repository instanceof IndexedDbRepository) await this.repository.resetLegacy();
    await this.repository.bootstrap();
    await this.repository.interruptActiveRuns();
    this.settings = await this.settingsRepository.load();
    this.mode = this.settings.mode;
    await this.gateway.registerContentScript().catch(() => undefined);
    this.initialized = true;
  }

  async handle(command: UiCommand): Promise<unknown> {
    await this.init();
    switch (command.type) {
      case "get_state":
        return this.snapshot();
      case "send_message":
        return this.startRun(command.text);
      case "stop_run":
        await this.stop(command.runId);
        return { stopped: true };
      case "confirm_action":
        return { accepted: this.resolveConfirmation(command.actionId, command.approved) };
      case "set_mode":
        await this.setMode(command.mode);
        return { mode: this.mode };
      case "save_settings": {
        await this.assertIdle();
        const next = appSettingsSchema.parse(command.settings);
        await this.settingsRepository.save(next);
        this.settings = next;
        this.mode = this.settings.mode;
        await this.pushState();
        return { saved: true };
      }
      case "set_model": {
        await this.assertIdle();
        const provider = this.settings.provider;
        if (!provider) throw new Error("Configure a provider in settings before choosing a model");
        const modelChanged = command.model !== provider.model;
        const next = updateActiveProvider(
          this.settings,
          providerSettingsSchema.parse({
            ...provider,
            model: command.model,
            availableModels: command.availableModels ?? provider.availableModels,
            capabilities: modelChanged ? providerCapabilitiesSchema.parse({}) : provider.capabilities,
          }),
        );
        await this.settingsRepository.save(next);
        this.settings = next;
        await this.pushState();
        if (modelChanged)
          this.emit("notice", {
            message: "Model changed. Re-test the provider in settings to refresh its capabilities.",
          });
        return { model: command.model };
      }
      case "set_provider": {
        await this.assertIdle();
        const next = selectProvider(this.settings, command.providerId);
        await this.settingsRepository.save(next);
        this.settings = next;
        await this.pushState();
        return { providerId: command.providerId };
      }
      case "test_provider":
        await this.assertIdle();
        return this.testProvider(command.provider);
      case "list_provider_models":
        await this.assertIdle();
        return this.listProviderModels(command.provider);
      case "request_site_access": {
        await this.assertIdle();
        const granted = await this.gateway.requestSiteAccess();
        await this.pushState();
        return { granted };
      }
      case "new_chat":
        await this.assertIdle();
        await this.repository.resetCurrentWorkspace();
        this.emit("stream_reset", {});
        await this.pushState();
        return { cleared: true };
      case "new_workspace":
        await this.assertIdle();
        await this.repository.createWorkspace(command.name ?? "New workspace");
        await this.pushState();
        return { created: true };
      case "update_note": {
        await this.assertIdle();
        const workspace = await this.repository.getWorkspace();
        const note = (await this.repository.listNotes(workspace.id)).find(
          (entry) => entry.id === command.noteId,
        );
        if (!note) throw new Error("Workspace note not found");
        await this.repository.putNote({
          ...note,
          title: command.title,
          content: command.content,
          generated: false,
          updatedAt: Date.now(),
        });
        await this.pushState();
        return { saved: true };
      }
      case "delete_note":
        await this.assertIdle();
        await this.repository.deleteNote(command.noteId);
        await this.pushState();
        return { deleted: true };
    }
  }

  private async snapshot() {
    const workspace = await this.repository.getWorkspace();
    const [messages, modelTurns, notes, activeRun, usage, hasSiteAccess] = await Promise.all([
      this.repository.listMessages(workspace.conversationId),
      this.repository.listModelTurns(workspace.conversationId),
      this.repository.listNotes(workspace.id),
      this.repository.getActiveRun(),
      this.repository.listUsage(),
      this.gateway.hasSiteAccess(),
    ]);
    return {
      settings: this.settings,
      mode: this.mode,
      workspace,
      messages,
      modelTurns,
      notes,
      activeRun,
      pendingConfirmation: this.pending
        ? ({ intent: this.pending.intent, requestedAt: Date.now() } satisfies PendingConfirmation)
        : null,
      usage: usage.slice(-100),
      hasSiteAccess,
    };
  }

  private async startRun(text: string): Promise<{ runId: string }> {
    await this.assertIdle();
    if (!this.settings.provider) throw new Error("Configure and test a provider before starting a run");
    // Reserve cancellation before any startup persistence awaits. Two concurrent sends
    // must not replace the controller that Stop is about to abort.
    if (this.abortController) throw new Error("Another run is active");
    const controller = new AbortController();
    this.abortController = controller;
    const providerSettings = this.settings.provider;
    try {
      const workspace = await this.repository.getWorkspace();
      const now = Date.now();
      const userMessageId = createId("message");
      const run: RunRecord = {
        id: createId("run"),
        workspaceId: workspace.id,
        conversationId: workspace.conversationId,
        userMessageId,
        status: "planning",
        mode: this.mode,
        sequence: 0,
        turnCount: 0,
        actionCount: 0,
        estimatedTokens: 0,
        actualTokens: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.currentRunId = run.id;
      await this.repository.putMessage({
        id: userMessageId,
        conversationId: workspace.conversationId,
        runId: run.id,
        sequence: 0,
        role: "user",
        content: text,
        createdAt: now,
      });
      await this.repository.putRun(run);
      await this.pushState(run.id);
      void this.continueRun(run, text, providerSettings, controller).catch(() => undefined);
      return { runId: run.id };
    } catch (error) {
      if (this.abortController === controller) {
        this.abortController = null;
        this.currentRunId = null;
      }
      throw error;
    }
  }

  private async continueRun(
    initialRun: RunRecord,
    userRequest: string,
    providerSettings: ProviderSettings,
    controller: AbortController,
  ): Promise<void> {
    let run = initialRun;
    let steps: ConversationStep[] = [];
    let compactedContext: string | undefined;
    const sources: SourceReference[] = [];
    let finalText = "";
    const provider = createProvider(providerSettings);
    const policy = makeTokenPolicy(providerSettings.contextWindow, providerSettings.maxOutputTokens);
    const deadline = setTimeout(() => controller.abort(new RunTimeoutError()), TOKEN_LIMITS.maxRunMs);

    try {
      for (let turn = 0; turn < providerSettings.maxThinkingTurns; turn += 1) {
        this.throwIfStopped(controller.signal, run.createdAt);
        const workspace = await this.repository.getWorkspace();
        const [messages, notes, activeTab] = await Promise.all([
          this.repository.listMessages(workspace.conversationId),
          this.repository.listNotes(workspace.id),
          abortable(controller.signal, () => this.gateway.activeTab()),
        ]);
        pruneSupersededReads(steps);
        const trace = traceFromSteps(steps);
        const compilation = this.compiler.compile({
          runId: run.id,
          sequence: turn,
          policy,
          userRequest,
          activeTab,
          mode: run.mode,
          messages: messages.filter((message) => message.id !== run.userMessageId),
          notes,
          trace,
          compactedContext,
        });
        await this.repository.putPromptPlan(compilation.plan);

        if (
          providerSettings.protocol === "chat_completions" &&
          compilation.plan.compactionRequired &&
          !compactedContext &&
          provider.compact
        ) {
          const compacted = await abortable(controller.signal, () =>
            provider.compact!({
              settings: providerSettings,
              messages: messages.slice(-TOKEN_LIMITS.recentPairs * 2).map((message) => ({
                role: message.role,
                content: message.content,
              })),
              policy,
              signal: controller.signal,
            }),
          );
          const compactUsage = persistedUsage(
            createId("usage"),
            run.id,
            turn,
            compilation.plan.estimatedInput,
            compacted.usage,
            compilation.plan.segments.map((segment) => ({
              kind: segment.kind,
              tokens: segment.estimatedTokens,
            })),
            "compaction",
          );
          await this.repository.putUsage(compactUsage);
          compactedContext = truncateToTokens(compacted.content, TOKEN_LIMITS.compactedSummary);
          // This compaction summarizes prior conversation only; retain current tool calls/results.
          run = await this.updateRun(run, {
            estimatedTokens: run.estimatedTokens + compilation.plan.estimatedInput,
            actualTokens: run.actualTokens + compactUsage.total,
          });
          continue;
        }

        const estimatedTotal = run.estimatedTokens + compilation.plan.estimatedInput;
        if (estimatedTotal > policy.runLimit) throw new Error("The run reached its configured token limit");
        run = await this.updateRun(run, {
          status: "responding",
          turnCount: turn + 1,
          estimatedTokens: estimatedTotal,
        });

        const request: ProviderRequest = {
          settings: providerSettings,
          compilation,
          baseMessages: compilation.messages,
          steps,
          tools: TOOL_DEFINITIONS,
          policy,
          requestSequence: turn,
          signal: controller.signal,
        };

        if (
          provider.countInput &&
          providerSettings.capabilities.exactCounting &&
          compilation.plan.estimatedInput >= policy.inputSoftLimit * 0.8
        ) {
          const exact = await abortable(controller.signal, () => provider.countInput!(request));
          if (exact > policy.inputHardLimit) {
            const compacted = await abortable(controller.signal, async () =>
              provider.compact?.({
                settings: providerSettings,
                messages: compilation.messages,
                steps,
                policy,
                signal: controller.signal,
              }),
            );
            if (!compacted)
              throw new ContextBudgetError(
                "Provider input exceeds the hard limit",
                exact,
                policy.inputHardLimit,
              );
            const compactUsage = persistedUsage(
              createId("usage"),
              run.id,
              turn,
              compilation.plan.estimatedInput,
              compacted.usage,
              compilation.plan.segments.map((segment) => ({
                kind: segment.kind,
                tokens: segment.estimatedTokens,
              })),
              "compaction",
            );
            await this.repository.putUsage(compactUsage);
            run = await this.updateRun(run, { actualTokens: run.actualTokens + compactUsage.total });
            if (compacted.opaqueItems) {
              compactedContext = undefined;
              steps = [
                { text: "", toolCalls: [], toolResults: [], rawResponseOutput: compacted.opaqueItems },
              ];
            } else {
              compactedContext = truncateToTokens(compacted.content, TOKEN_LIMITS.compactedSummary);
              steps = [];
            }
            continue;
          }
        }

        let streamedText = "";
        this.emit("stream_reset", { turn }, run.id);
        let result;
        try {
          result = await abortable(controller.signal, () =>
            provider.stream(request, (event) => {
              if (controller.signal.aborted || this.abortController !== controller) return;
              if (event.type === "text_delta") {
                streamedText += event.text;
                this.emit("stream_delta", { text: event.text, turn }, run.id);
              }
            }),
          );
        } catch (error) {
          if (streamedText.trim()) {
            await this.persistModelTurn(run, turn, streamedText, [], "failed");
          }
          throw error;
        }
        this.throwIfStopped(controller.signal, run.createdAt);
        finalText = result.text || streamedText;
        if (result.toolCalls.length > 0) {
          await this.persistModelTurn(run, turn, finalText, result.toolCalls, "completed");
        }
        const usage = persistedUsage(
          createId("usage"),
          run.id,
          turn,
          compilation.plan.estimatedInput,
          result.usage,
          compilation.plan.segments.map((segment) => ({
            kind: segment.kind,
            tokens: segment.estimatedTokens,
          })),
        );
        await this.repository.putUsage(usage);
        run = await this.updateRun(run, { actualTokens: run.actualTokens + usage.total });
        if (run.actualTokens > policy.runLimit) throw new Error("The run reached its configured token limit");
        if (result.incomplete) {
          if (finalText.trim()) await this.persistModelTurn(run, turn, finalText, [], "failed");
          throw new Error("The provider stopped because its output limit was reached");
        }

        const step: ConversationStep = {
          text: finalText,
          toolCalls: result.toolCalls,
          toolResults: [],
          rawResponseOutput: result.rawResponseOutput,
        };
        steps.push(step);

        if (result.toolCalls.length === 0) {
          const assistantText = finalText.trim() || "Completed without a textual response.";
          await this.repository.putMessage({
            id: createId("message"),
            conversationId: run.conversationId,
            runId: run.id,
            sequence: run.sequence + 1,
            role: "assistant",
            content: assistantText,
            createdAt: Date.now(),
          });
          await this.createRunNote(run, userRequest, assistantText, sources);
          run = await this.updateRun(run, { status: "completed" });
          this.emit("notice", { message: "Run completed" }, run.id);
          return;
        }

        const actionsStarted: ToolCall["name"][] = [];
        for (const call of result.toolCalls) {
          this.throwIfStopped(controller.signal, run.createdAt);
          if (run.actionCount >= TOKEN_LIMITS.maxActions)
            throw new Error("The run reached its browser-action limit");
          run = await this.updateRun(run, { status: "executing" });
          let execution: { output: string; source?: SourceReference };
          try {
            execution = await this.executeTool(run, call, controller.signal, () => {
              actionsStarted.push(call.name);
            });
          } catch (toolError) {
            // A failed tool (e.g. STALE_HANDLE after page churn) is data for
            // the model, not a fatal run error: report it as the tool result
            // so the next turn can re-snapshot and retry instead of dying.
            if (controller.signal.aborted) throw toolError;
            execution = { output: stableStringify({ status: "failed", error: errorMessage(toolError) }) };
          } finally {
            if (actionsStarted.length)
              await this.persistModelTurn(
                run,
                turn,
                finalText,
                result.toolCalls,
                "completed",
                actionsStarted,
              );
          }
          this.throwIfStopped(controller.signal, run.createdAt);
          step.toolResults.push({ callId: call.id, output: execution.output });
          if (execution.source && !sources.some((source) => source.url === execution.source?.url))
            sources.push(execution.source);
          run = await this.updateRun(run, { actionCount: run.actionCount + 1, status: "planning" });
        }
      }
      throw new Error("The run reached its model-turn limit");
    } catch (error) {
      // stop() aborts with the default DOMException reason; the run deadline
      // aborts with a RunTimeoutError, which must remain a failure, not a cancellation.
      const timedOut = controller.signal.aborted && controller.signal.reason instanceof RunTimeoutError;
      const cancelled = controller.signal.aborted && !timedOut;
      run = await this.updateRun(run, {
        status: cancelled ? "cancelled" : "failed",
        error: cancelled ? "Stopped by user" : errorMessage(error),
      });
      this.emit(cancelled ? "notice" : "error", { message: run.error }, run.id);
    } finally {
      clearTimeout(deadline);
      if (this.pending?.intent.runId === run.id) {
        this.pending.resolve(false);
        this.pending = null;
      }
      if (this.abortController === controller) {
        this.abortController = null;
        this.currentRunId = null;
      }
      // Publish terminal state only after releasing the run lock.
      await this.pushState(run.id);
    }
  }

  private async executeTool(
    run: RunRecord,
    call: ToolCall,
    signal: AbortSignal,
    onMutationStarted: () => void,
  ): Promise<{ output: string; source?: SourceReference }> {
    this.throwIfStopped(signal, run.createdAt);
    const input = parseToolInput(call.name, call.arguments);
    let target: TargetDescriptor | undefined;
    if (["click", "fill", "select", "set_checked", "submit"].includes(call.name)) {
      try {
        target = await abortable(signal, () => this.gateway.describe(input.handle, signal));
      } catch (describeError) {
        if (!signal.aborted) throw describeError;
        // Keep an audit record of the interrupted intent; no effect was dispatched.
        const interrupted = makeActionIntent(run.id, call.name, input, undefined);
        await this.repository.putAction({
          ...interrupted,
          status: "failed",
          detail: "Stopped before browser action completed",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        throw describeError;
      }
    }
    const intent = makeActionIntent(run.id, call.name, input, target);
    const now = Date.now();
    await this.repository.putAction({
      ...intent,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    });

    if (requiresConfirmation(run.mode, intent.classification)) {
      await this.updateRun(run, { status: "awaiting_confirmation" });
      const approved = await this.requestConfirmation(intent, signal);
      await this.repository.putAction({
        ...intent,
        status: approved ? "approved" : "denied",
        createdAt: now,
        updatedAt: Date.now(),
      });
      if (!approved) return { output: stableStringify({ status: "denied_by_user" }) };
    }

    await this.repository.putAction({ ...intent, status: "started", createdAt: now, updatedAt: Date.now() });
    let result;
    let dispatched = false;
    try {
      this.throwIfStopped(signal, run.createdAt);
      result = await abortable(signal, () => {
        dispatched = true;
        if (intent.classification !== "read") onMutationStarted();
        return this.gateway.execute(call.name, input, signal);
      });
    } catch (error) {
      await this.repository.putAction({
        ...intent,
        // A cancelled read is just failed; a cancelled mutation may already
        // have taken effect in the page, so its outcome is genuinely unknown.
        status: signal.aborted && dispatched && intent.classification !== "read" ? "unverified" : "failed",
        // Do not persist arbitrary page errors: they may contain form values.
        detail: signal.aborted
          ? "Stopped; any already-dispatched effect cannot be undone or verified"
          : "Browser action failed",
        createdAt: now,
        updatedAt: Date.now(),
      });
      throw error;
    }
    const toolStatus =
      result.output.status === "failed" || result.output.matched === false
        ? "failed"
        : result.output.status === "unverified"
          ? "unverified"
          : "succeeded";
    await this.repository.putAction({
      ...intent,
      status: toolStatus,
      detail: typeof result.output.reason === "string" ? result.output.reason : undefined,
      createdAt: now,
      updatedAt: Date.now(),
    });
    const maximum =
      call.name === "read_page"
        ? Math.min(Number(input.maxTokens ?? TOKEN_LIMITS.defaultPageResult), TOKEN_LIMITS.maximumPageResult)
        : ["list_tabs", "list_frames"].includes(call.name)
          ? 600
          : TOKEN_LIMITS.toolResult;
    return {
      // read_page already budgets the complete structured snapshot, including handles/cursors.
      output:
        call.name === "read_page"
          ? stableStringify(result.output)
          : serializeToolResult(result.output, maximum),
      source: result.source,
    };
  }

  private requestConfirmation(intent: ActionIntent, signal: AbortSignal): Promise<boolean> {
    if (this.pending) throw new Error("A confirmation is already pending");
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const abort = () => {
        if (this.pending?.intent.id === intent.id) this.pending = null;
        resolve(false);
      };
      signal.addEventListener("abort", abort, { once: true });
      this.pending = {
        intent,
        resolve: (approved) => {
          signal.removeEventListener("abort", abort);
          this.pending = null;
          resolve(approved);
        },
      };
      this.emit("state", { pendingConfirmation: { intent, requestedAt: Date.now() } }, intent.runId);
      void this.pushState(intent.runId);
    });
  }

  private resolveConfirmation(actionId: string, approved: boolean): boolean {
    if (!this.pending || this.pending.intent.id !== actionId) return false;
    this.pending.resolve(approved);
    return true;
  }

  private async stop(runId?: string): Promise<void> {
    if (runId && this.currentRunId !== runId) return;
    this.abortController?.abort();
    this.pending?.resolve(false);
    this.pending = null;
  }

  private async setMode(mode: SafetyMode): Promise<void> {
    await this.assertIdle();
    this.mode = mode;
    if (mode !== "yolo") {
      this.settings = { ...this.settings, mode };
      await this.settingsRepository.save(this.settings);
    }
    await this.pushState();
  }

  private async testProvider(value: ProviderSettings) {
    const provider = providerSettingsSchema.parse(value);
    const adapter = createProvider(provider);
    const policy = makeTokenPolicy(provider.contextWindow, provider.maxOutputTokens);
    const compilation = this.compiler.compile({
      runId: "provider_test",
      sequence: 0,
      policy,
      userRequest: "Reply with OK only.",
      mode: "agent",
      messages: [],
      notes: [],
      trace: [],
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const baseRequest: ProviderRequest = {
      settings: { ...provider, capabilities: providerCapabilitiesSchema.parse({}) },
      compilation,
      baseMessages: compilation.messages,
      steps: [],
      tools: [],
      policy,
      requestSequence: 0,
      signal: controller.signal,
    };
    try {
      let exactCounting = false;
      if (provider.protocol === "responses" && adapter.countInput) {
        try {
          await adapter.countInput(baseRequest);
          exactCounting = true;
        } catch {
          exactCounting = false;
        }
      }
      const result = await adapter.stream(baseRequest, () => undefined);
      let explicitCaching = false;
      let nativeCompaction = false;
      if (provider.protocol === "responses") {
        try {
          await adapter.stream(
            {
              ...baseRequest,
              settings: {
                ...baseRequest.settings,
                capabilities: { ...baseRequest.settings.capabilities, explicitCaching: true },
              },
            },
            () => undefined,
          );
          explicitCaching = true;
        } catch {
          explicitCaching = false;
        }
        try {
          await adapter.stream(
            {
              ...baseRequest,
              settings: {
                ...baseRequest.settings,
                capabilities: { ...baseRequest.settings.capabilities, nativeCompaction: true },
              },
            },
            () => undefined,
          );
          nativeCompaction = true;
        } catch {
          nativeCompaction = false;
        }
      }
      const capabilities = providerCapabilitiesSchema.parse({
        exactCounting,
        explicitCaching,
        nativeCompaction,
        streamingUsage: !result.usage.estimated,
      });
      return { capabilities, message: result.text.trim() || "Connection succeeded" };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listProviderModels(provider: ProviderConnection) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      return { models: await fetchProviderModels(provider, controller.signal) };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async persistModelTurn(
    run: RunRecord,
    turn: number,
    content: string,
    toolCalls: ToolCall[],
    status: "completed" | "failed",
    actionsStarted: ToolCall["name"][] = [],
  ): Promise<void> {
    await this.repository.putModelTurn({
      id: `${run.id}:model-turn:${turn}`,
      conversationId: run.conversationId,
      runId: run.id,
      turn,
      content: content.trim(),
      tools: toolCalls.map((call) => call.name),
      actionsStarted,
      status,
      createdAt: Date.now(),
    });
  }

  private async createRunNote(
    run: RunRecord,
    request: string,
    response: string,
    sources: SourceReference[],
  ): Promise<void> {
    if (sources.length === 0) return;
    const now = Date.now();
    await this.repository.putNote({
      id: createId("note"),
      workspaceId: run.workspaceId,
      runId: run.id,
      title: truncateToTokens(request, 24),
      content: truncateToTokens(response, 220),
      sources,
      generated: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  private async updateRun(run: RunRecord, patch: Partial<RunRecord>): Promise<RunRecord> {
    const next = {
      ...run,
      ...patch,
      sequence: run.sequence + 1,
      updatedAt: Date.now(),
    };
    // A stop arriving during persistence must not allow subsequent work to restart.
    if (
      this.currentRunId === run.id &&
      this.abortController?.signal.aborted &&
      !["cancelled", "failed"].includes(next.status)
    ) {
      this.abortController.signal.throwIfAborted();
    }
    await this.repository.putRun(next);
    if (!["completed", "cancelled", "failed"].includes(next.status)) await this.pushState(run.id);
    return next;
  }

  private async assertIdle(): Promise<void> {
    if (this.abortController || (await this.repository.getActiveRun())) {
      throw new Error("Another run is active. Stop it before changing state.");
    }
  }

  private throwIfStopped(signal: AbortSignal, startedAt: number): void {
    if (signal.aborted)
      throw signal.reason instanceof Error ? signal.reason : new DOMException("Stopped", "AbortError");
    if (Date.now() - startedAt > TOKEN_LIMITS.maxRunMs) throw new Error("The run reached its time limit");
  }

  private emit(type: AgentEvent["type"], payload: unknown, runId?: string): void {
    this.emitEvent({
      version: 1,
      eventId: createId("event"),
      runId,
      sequence: this.eventSequence++,
      type,
      payload,
    });
  }

  private async pushState(runId?: string): Promise<void> {
    const sequence = ++this.snapshotSequence;
    const state = await this.snapshot();
    if (sequence === this.snapshotSequence) this.emit("state", state, runId);
  }
}

function traceFromSteps(steps: ConversationStep[]): TraceSegment[] {
  const trace: TraceSegment[] = [];
  for (const step of steps) {
    if (step.text) trace.push({ kind: "tool_trace", content: step.text });
    for (const call of step.toolCalls) {
      const result = step.toolResults.find((entry) => entry.callId === call.id);
      if (!result) continue;
      trace.push({
        kind: call.name === "read_page" ? "page" : "tool_trace",
        content: `${call.name}(${stableStringify(call.arguments)}) => ${result.output}`,
      });
    }
  }
  return trace;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
