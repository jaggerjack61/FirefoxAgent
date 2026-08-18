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
  /** Approximate input/output token usage if reported by the API. */
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface LLMRequest {
  messages: LLMMessage[];
  tools?: LLMToolDef[];
  temperature?: number;
  maxOutputTokens?: number;
  /** Ask the model to emit strict JSON only (structured-output fallback). */
  jsonMode?: boolean;
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
}

// ---------------------------------------------------------------------------
// Provider configuration
// ---------------------------------------------------------------------------

export type ProviderProtocol = "chat_completions" | "responses";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

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

export interface AppSettings {
  provider: ProviderConfig;
  mode: AgentMode;
  limits: AgentLimits;
  privacy: PrivacySettings;
  compression: CompressionSettings;
  memory: MemorySettings;
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
  | { kind: "llm_response"; ts: number; latencyMs: number; finishReason: string; estimatedTokens: number; toolCalls: number; iteration: number }
  | { kind: "tool_call"; ts: number; tool: string; input: unknown; output?: unknown; ok: boolean; latencyMs: number }
  | { kind: "context"; ts: number; layers: Record<string, number>; totalTokens: number; compressed: boolean }
  | { kind: "snapshot"; ts: number; tabId: number; url: string; elements: number; textChars: number }
  | { kind: "confirmation"; ts: number; tool: string; approved: boolean; highRisk: boolean }
  | { kind: "error"; ts: number; code: string; message: string };
