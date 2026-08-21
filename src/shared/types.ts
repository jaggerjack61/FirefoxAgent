/**
 * Shared core types used across background, content scripts and sidebar.
 * Keep this file free of runtime imports so it can be included anywhere.
 */

// ---------------------------------------------------------------------------
// Chat / LLM messages
// ---------------------------------------------------------------------------

export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Parsed JSON arguments (never trust raw model output — validated later). */
  arguments: Record<string, unknown>;
}

export interface LLMMessage {
  role: ChatRole;
  content: string | null;
  /** Present on assistant messages that requested tools. */
  toolCalls?: ToolCall[];
  /** Present on tool messages; links back to the assistant tool call. */
  toolCallId?: string;
  name?: string;
}

export interface LLMToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
  /** Token and provider-cache usage when reported by the API. */
  usage?: LLMUsage;
}

export interface LLMUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheMissTokens?: number;
  cacheWriteTokens?: number;
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the model to emit strict JSON only (structured-output fallback). */
  jsonMode?: boolean;
  /** Stable conversation/session key used by providers for prompt-cache routing. */
  cacheKey?: string;
  /** Marks the leading system/developer content as a reusable cache prefix. */
  cacheStablePrefix?: boolean;
  /** Model to serve this request. When omitted, the provider's configured model is used. */
  model?: string;
}

export type StreamEvent =
  | { kind: "text_delta"; text: string }
  | { kind: "tool_call_delta"; callId: string; name: string; argsDelta: string }
  | { kind: "done"; response: LLMResponse }
  | { kind: "error"; error: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Model capabilities
// ---------------------------------------------------------------------------

export interface ModelCapabilities {
  tools: boolean;
  streaming: boolean;
  parallelTools: boolean;
  structuredOutput: boolean;
  /** Estimated context window in tokens; 0 = unknown. */
  maxContextTokens?: number;
  /** Whether the provider can cache a stable prompt prefix. */
  supportsPromptCaching: boolean;
  /**
   * How the provider expects cache routing to be signalled.
   * - "implicit": prefix is cached automatically; no cache key sent (DeepSeek).
   * - "explicit": a cache key + breakpoints are sent (OpenAI GPT-5.6+).
   */
  cacheKeyStrategy: "implicit" | "explicit";
}

// ---------------------------------------------------------------------------
// Token efficiency
// ---------------------------------------------------------------------------

/**
 * User-selectable aggressiveness for token usage. Drives a {@link TokenProfile}
 * of concrete caps/thresholds via {@link resolveTokenProfile}.
 *
 * - "conservative" — keep full history, pretty-printed tool output, no dedup.
 * - "balanced" — compact prior runtime-context, compact JSON, dedupe reads.
 * - "aggressive" — smallest caps, earliest compression, replace prior context.
 * - "auto" — pick a level from the model's context window at runtime.
 */
export type TokenEfficiencyLevel = "conservative" | "balanced" | "aggressive" | "auto";

/**
 * How prior runtime-context messages (task + workspace + active-tab snapshot)
 * are treated when a new one is appended each turn.
 * - "retain" — leave prior messages verbatim (compression handles them later).
 * - "compress-previous" — replace the prior runtime-context with a stub.
 * - "replace-previous" — replace prior + strip active-tab text from the stub.
 */
export type RuntimeContextRetention = "retain" | "compress-previous" | "replace-previous";

/**
 * Concrete token-efficiency knobs resolved from a {@link TokenEfficiencyLevel}.
 * Consumers read these instead of raw settings so behaviour is level-driven.
 */
export interface TokenProfile {
  level: TokenEfficiencyLevel;
  /** Per-observation hard cap (chars) applied in renderToolOutput. */
  toolOutputHardCap: number;
  /** Cap (chars) for tool observations kept verbatim in the recent window. */
  recentToolOutputCap: number;
  /** Conversation length (messages) that triggers compression. */
  summarizeThreshold: number;
  /** Number of most-recent messages kept verbatim. */
  keepRecentMessages: number;
  /** How prior runtime-context messages are treated. */
  runtimeContextRetention: RuntimeContextRetention;
  /** Snapshot visible-text cap (chars); overrides limits.maxPageTextChars. */
  maxPageTextChars: number;
  /** Serialize tool outputs as compact JSON (no indentation). */
  compactToolJson: boolean;
  /** Return a stub for redundant same-version page reads. */
  dedupePageReads: boolean;
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export type ProviderProtocol = "chat_completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * A single provider endpoint (base URL + key) that serves a set of models.
 * Used for multi-endpoint routing: each model request is sent to the
 * endpoint that lists that model.
 */
export interface ProviderEndpoint {
  /** Stable id used as a React key and for routing bookkeeping. */
  id: string;
  /** Human-readable label, e.g. "OpenAI", "Ollama (local)". */
  name: string;
  /** e.g. https://api.openai.com/v1 — the protocol path is appended. */
  baseUrl: string;
  apiKey: string;
  /** Models served by this endpoint. Empty array = serves any model. */
  models: string[];
  protocol: ProviderProtocol;
  customHeaders: Record<string, string>;
  timeoutMs: number;
}

export interface ProviderConfig {
  name: string;
  /** e.g. https://api.openai.com/v1 — the protocol path is appended. */
  baseUrl: string;
  apiKey: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  protocol: ProviderProtocol;
  customHeaders: Record<string, string>;
  temperature: number;
  maxOutputTokens: number;
  /** Context window limit in tokens used for budgeting. */
  contextLimitTokens: number;
  timeoutMs: number;
  /** Optional capability overrides (auto-detected by default). */
  capabilitiesOverride?: Partial<ModelCapabilities>;
  /**
   * Optional multi-endpoint routing table. When present, each model request
   * is routed to the endpoint that serves the requested model; the top-level
   * baseUrl/apiKey/model act as the fallback for unlisted models.
   */
  endpoints?: ProviderEndpoint[];
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type AgentMode = "interactive" | "agent" | "yolo";

export interface AgentLimits {
  maxActionsPerTask: number;
  maxTabsInspected: number;
  maxPageTextChars: number;
  maxSnapshotElements: number;
  taskTimeoutMs: number;
}

export interface PrivacySettings {
  allowActivePageContent: boolean;
  allowOtherTabContent: boolean;
  allowFormValues: boolean;
  allowSelectedText: boolean;
  /** Password inputs are always excluded; this toggles other sensitive types. */
  excludeSensitiveFields: boolean;
}

export interface CompressionSettings {
  enabled: boolean;
  /** Number of most-recent messages kept verbatim. */
  keepRecentMessages: number;
  /** Conversation length (messages) that triggers compression. */
  summarizeThreshold: number;
}

export interface MemorySettings {
  enabled: boolean;
  /** Auto-summarize inspected pages into the workspace memory. */
  autoSummarizePages: boolean;
}

export interface TokenEfficiencySettings {
  /** Aggressiveness level; "auto" picks from the model's context window. */
  level: TokenEfficiencyLevel;
}

export interface AppSettings {
  provider: ProviderConfig;
  mode: AgentMode;
  limits: AgentLimits;
  privacy: PrivacySettings;
  compression: CompressionSettings;
  memory: MemorySettings;
  tokenEfficiency: TokenEfficiencySettings;
  devMode: boolean;
  /** Search engine used by the search_web tool. */
  searchEngine: "google" | "duckduckgo" | "bing";
}

// ---------------------------------------------------------------------------
// Workspace / task state
// ---------------------------------------------------------------------------

export interface Fact {
  id: string;
  text: string;
  category?: string;
  sourceTabId?: number;
  sourceUrl?: string;
  createdAt: number;
  /** True when the fact came from a page that has since navigated away. */
  stale?: boolean;
}

export interface WorkspaceTab {
  tabId: number;
  url: string;
  title: string;
  pinned: boolean;
  summary?: string;
  importantFacts: Fact[];
  extractedEntities: string[];
  lastInspectedAt?: number;
  /** True when the tab's URL changed after inspection (facts kept, marked stale). */
  pageChangedSinceInspection?: boolean;
}

export type TaskStatus =
  | "planning"
  | "running"
  | "awaiting_user"
  | "completed"
  | "failed"
  | "stopped";

export interface TaskStep {
  id: string;
  description: string;
  status: "pending" | "done" | "failed";
}

export interface AgentTask {
  id: string;
  goal: string;
  status: TaskStatus;
  referencedTabIds: number[];
  completedSteps: TaskStep[];
  pendingSteps: TaskStep[];
  importantFacts: Fact[];
  createdAt: number;
  updatedAt: number;
  /** Set when awaiting a confirmation decision. */
  pendingConfirmationId?: string;
  error?: string;
}

export interface Workspace {
  id: string;
  name: string;
  conversationId: string;
  createdAt: number;
  updatedAt: number;
  activeTaskId?: string;
  tabs: WorkspaceTab[];
}

// ---------------------------------------------------------------------------
// Agent runtime state (mirrored to the sidebar)
// ---------------------------------------------------------------------------

export interface AgentRuntimeState {
  status: "idle" | "planning" | "running" | "awaiting_user" | "completed" | "failed" | "stopped";
  taskId?: string;
  iterations: number;
  /** Human-readable line describing the current activity. */
  currentActivity?: string;
  error?: string;
}

export interface ConfirmationRequest {
  id: string;
  tool: string;
  /** Short description of the proposed action, e.g. "Submit checkout form ($249.99)". */
  description: string;
  details: string;
  tabId?: number;
  requestedAt: number;
  /** Confirmation expires (auto-cancel) at this timestamp. */
  expiresAt: number;
  /** When true the action is irreversible. */
  highRisk: boolean;
}

export interface ActionLogEntry {
  id: string;
  at: number;
  tool: string;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
  tabId?: number;
}

// ---------------------------------------------------------------------------
// Conversation persistence
// ---------------------------------------------------------------------------

export interface ChatMessageRecord {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: number;
  conversationId: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface ConversationRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageIds: string[];
  /** Aggregate provider usage for the conversation. */
  tokenUsage?: TokenUsageMetrics;
}

/** Aggregate usage shown in the compact chat metrics bar. */
export interface TokenUsageMetrics {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheMissTokens: number;
  cacheWriteTokens: number;
  requestCount: number;
  cacheReportingRequests: number;
  estimatedRequests: number;
  /** Input/context tokens for the latest provider request. */
  lastContextTokens: number;
  contextLimitTokens: number;
}

export interface ToolActivityRecord {
  id: string;
  conversationId: string;
  /** Thinking entries are concise progress summaries, never raw model reasoning. */
  kind?: "tool" | "thinking";
  tool: string;
  label: string;
  status: "running" | "ok" | "error";
  detail?: string;
  tabId?: number;
  startedAt: number;
  finishedAt?: number;
}

// ---------------------------------------------------------------------------
// Dev-mode observability
// ---------------------------------------------------------------------------

export type DevEvent =
  | { kind: "llm_request"; ts: number; messageCount: number; estimatedTokens: number; contextLayers: Record<string, number>; model: string }
  | { kind: "llm_response"; ts: number; latencyMs: number; finishReason: string; estimatedTokens: number; toolCalls: number; iteration: number; usage?: LLMUsage }
  | { kind: "tool_call"; ts: number; tool: string; input: unknown; output?: unknown; ok: boolean; latencyMs: number }
  | { kind: "context"; ts: number; layers: Record<string, number>; totalTokens: number; compressed: boolean; activeTabSkipped?: boolean; cacheWarning?: string }
  | { kind: "cache_feedback"; ts: number; hitRate: number; requestCount: number; warning?: string }
  | { kind: "snapshot"; ts: number; tabId: number; url: string; elements: number; textChars: number }
  | { kind: "confirmation"; ts: number; tool: string; approved: boolean; highRisk: boolean }
  | { kind: "error"; ts: number; code: string; message: string };

/**
 * A full request/response exchange log for the dev panel's export feature.
 * Captures the exact messages sent to the provider (including page snapshots
 * embedded in the runtime-context block) and the response returned, so the
 * user can audit what was sent and received. Logs are scoped to the current
 * conversation and cleared when a new chat is started.
 */
export interface LLMExchangeLog {
  /** Stable id for React keys. */
  id: string;
  /** Epoch milliseconds when the request was dispatched. */
  ts: number;
  /** Wall-clock latency of the provider call, in milliseconds. */
  latencyMs: number;
  /** Model the request was routed to. */
  model: string;
  /** The exact message array sent to the provider (system + conversation + runtime context). */
  requestMessages: LLMMessage[];
  /** Tool definitions advertised to the model (omitted when not using native tools). */
  requestTools?: LLMToolDef[];
  /** The provider's raw response (content, tool calls, finish reason, usage). */
  response: LLMResponse;
  /** Whether the request was forced into a final-answer turn (action budget exhausted). */
  forceFinal: boolean;
  /** Whether the request ran in structured-output fallback mode (no native tools). */
  fallbackMode: boolean;
}
