import { z } from "zod";
import { TOKEN_LIMITS } from "./token";

export const protocolSchema = z.enum(["responses", "chat_completions"]);
export type ProviderProtocol = z.infer<typeof protocolSchema>;

export const providerCapabilitiesSchema = z.object({
  exactCounting: z.boolean().default(false),
  explicitCaching: z.boolean().default(false),
  nativeCompaction: z.boolean().default(false),
  streamingUsage: z.boolean().default(false),
});
export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

export const providerConnectionSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string(),
});
export type ProviderConnection = z.infer<typeof providerConnectionSchema>;

export const providerSettingsSchema = z.object({
  protocol: protocolSchema,
  ...providerConnectionSchema.shape,
  model: z.string().trim().min(1).max(200),
  availableModels: z.array(z.string().trim().min(1).max(200)).max(1_000).default([]),
  contextWindow: z
    .number()
    .int()
    .min(TOKEN_LIMITS.minimumContext)
    .max(2_000_000)
    .default(TOKEN_LIMITS.defaultContext),
  maxOutputTokens: z.number().int().min(256).max(128_000).default(TOKEN_LIMITS.defaultOutputReserve),
  maxThinkingTurns: z.number().int().min(1).default(TOKEN_LIMITS.maxTurns),
  /** Run until the model answers or the user stops it: no turn, action, time, or run-token ceiling. */
  unlimitedTurns: z.boolean().default(false),
  capabilities: providerCapabilitiesSchema.default({}),
});
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;

export interface RunLimits {
  turns: number;
  actions: number;
  durationMs: number;
  tokens: number;
}

/** Operational ceilings scale with the configured turn budget so raising it is never silently capped. */
export function runLimits(settings: ProviderSettings, policy: TokenPolicy): RunLimits {
  if (settings.unlimitedTurns)
    return { turns: Infinity, actions: Infinity, durationMs: Infinity, tokens: Infinity };
  const scale = Math.max(1, settings.maxThinkingTurns / TOKEN_LIMITS.maxTurns);
  return {
    turns: settings.maxThinkingTurns,
    actions: Math.ceil(TOKEN_LIMITS.maxActions * scale),
    durationMs: Math.ceil(TOKEN_LIMITS.maxRunMs * scale),
    tokens: Math.ceil(policy.runLimit * scale),
  };
}

export const tokenPolicySchema = z.object({
  contextWindow: z.number().int().min(TOKEN_LIMITS.minimumContext),
  outputReserve: z.number().int().positive(),
  inputSoftLimit: z.number().int().positive(),
  inputHardLimit: z.number().int().positive(),
  runLimit: z.number().int().positive(),
});
export type TokenPolicy = z.infer<typeof tokenPolicySchema>;

export function makeTokenPolicy(contextWindow: number, outputReserve: number): TokenPolicy {
  const context = Math.max(TOKEN_LIMITS.minimumContext, Math.floor(contextWindow));
  const reserve = Math.min(Math.max(256, Math.floor(outputReserve)), Math.floor(context * 0.4));
  return tokenPolicySchema.parse({
    contextWindow: context,
    outputReserve: reserve,
    inputSoftLimit: Math.floor(context * 0.7),
    inputHardLimit: context - reserve - Math.floor(context * 0.1),
    runLimit: context * 4,
  });
}

export const safetyModeSchema = z.enum(["interactive", "agent", "yolo"]);
export type SafetyMode = z.infer<typeof safetyModeSchema>;

export const persistedSafetyModeSchema = z.enum(["interactive", "agent"]);

export const providerProfileSchema = z.object({
  id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(80),
  settings: providerSettingsSchema,
});
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const appSettingsSchema = z
  .object({
    // Compatibility projection for the active profile and migration from v1 storage.
    provider: providerSettingsSchema.nullable().default(null),
    providers: z.array(providerProfileSchema).max(50).optional(),
    activeProviderId: z.string().nullable().optional(),
    mode: persistedSafetyModeSchema.default("agent"),
  })
  .transform((value, ctx) => {
    const providers =
      value.providers ??
      (value.provider ? [{ id: "legacy", name: "Default provider", settings: value.provider }] : []);
    const activeProviderId =
      value.activeProviderId === undefined ? (providers[0]?.id ?? null) : value.activeProviderId;
    if (
      new Set(providers.map((profile) => profile.id)).size !== providers.length ||
      (activeProviderId !== null && !providers.some((profile) => profile.id === activeProviderId))
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provider IDs must be unique and the active provider must exist",
      });
      return z.NEVER;
    }
    return {
      mode: value.mode,
      providers,
      activeProviderId,
      provider: providers.find((profile) => profile.id === activeProviderId)?.settings ?? null,
    };
  });
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const DEFAULT_SETTINGS: AppSettings = {
  provider: null,
  providers: [],
  activeProviderId: null,
  mode: "agent",
};

export const contextSegmentKindSchema = z.enum([
  "stable",
  "run_state",
  "user",
  "tool_trace",
  "page",
  "recent_history",
  "workspace_memory",
  "compaction",
]);

export const tokenUsageSchema = z.object({
  id: z.string(),
  runId: z.string(),
  requestSequence: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  estimatedInput: z.number().int().nonnegative(),
  input: z.number().int().nonnegative(),
  cachedInput: z.number().int().nonnegative(),
  cacheWrite: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  reasoning: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  estimated: z.boolean(),
  kind: z.enum(["request", "compaction"]).default("request"),
  segments: z
    .array(
      z.object({
        kind: contextSegmentKindSchema,
        tokens: z.number().int().nonnegative(),
      }),
    )
    .default([]),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const contextSegmentSchema = z.object({
  kind: contextSegmentKindSchema,
  priority: z.number().int(),
  contentHash: z.string(),
  estimatedTokens: z.number().int().nonnegative(),
  required: z.boolean(),
  content: z.string(),
});
export type ContextSegment = z.infer<typeof contextSegmentSchema>;

export const promptPlanSchema = z.object({
  id: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  segments: z.array(contextSegmentSchema),
  estimatedInput: z.number().int().nonnegative(),
  omitted: z.array(
    z.object({
      kind: contextSegmentKindSchema,
      reason: z.string(),
      estimatedTokens: z.number().int().nonnegative(),
    }),
  ),
  compactionRequired: z.boolean(),
});
export type PromptPlan = z.infer<typeof promptPlanSchema>;

export const conversationRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const workspaceRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  name: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;

export const messageRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  sequence: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant"]),
  content: z.string(),
  createdAt: z.number().int(),
});
export type MessageRecord = z.infer<typeof messageRecordSchema>;

export const sourceReferenceSchema = z.object({
  tabId: z.number().int(),
  url: z.string(),
  title: z.string(),
  capturedAt: z.number().int(),
});
export type SourceReference = z.infer<typeof sourceReferenceSchema>;

export const workspaceNoteSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string().optional(),
  title: z.string(),
  content: z.string(),
  sources: z.array(sourceReferenceSchema),
  generated: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkspaceNote = z.infer<typeof workspaceNoteSchema>;

export const runStatusSchema = z.enum([
  "planning",
  "awaiting_confirmation",
  "executing",
  "responding",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const runRecordSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  conversationId: z.string(),
  userMessageId: z.string(),
  status: runStatusSchema,
  mode: safetyModeSchema,
  sequence: z.number().int().nonnegative(),
  turnCount: z.number().int().nonnegative(),
  actionCount: z.number().int().nonnegative(),
  estimatedTokens: z.number().int().nonnegative(),
  actualTokens: z.number().int().nonnegative(),
  error: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const toolNameSchema = z.enum([
  "list_tabs",
  "open_tab",
  "activate_tab",
  "close_tab",
  "navigate",
  "go_back",
  "reload",
  "read_page",
  "list_frames",
  "wait_for",
  "search_history",
  "search_bookmarks",
  "click",
  "fill",
  "select",
  "set_checked",
  "submit",
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const modelTurnRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  runId: z.string(),
  turn: z.number().int().nonnegative(),
  content: z.string(),
  tools: z.array(toolNameSchema),
  // Absent on legacy turns; new turns distinguish requested tools from dispatched mutations.
  actionsStarted: z.array(toolNameSchema).optional(),
  status: z.enum(["completed", "failed"]),
  createdAt: z.number().int(),
});
export type ModelTurnRecord = z.infer<typeof modelTurnRecordSchema>;

export const elementHandleSchema = z.object({
  tabId: z.number().int(),
  frameId: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  id: z.string(),
});
export type ElementHandle = z.infer<typeof elementHandleSchema>;

// Model-facing handles are one opaque string, "tabId.frameId.revision.id": a quarter of
// the tokens of the JSON object, in every page read and every action call.
const HANDLE_PATTERN = /^(-?\d+)\.(\d+)\.(\d+)\.(\S+)$/u;

export function formatHandle(handle: ElementHandle): string {
  return `${handle.tabId}.${handle.frameId}.${handle.revision}.${handle.id}`;
}

export function parseHandle(value: string): ElementHandle {
  const match = HANDLE_PATTERN.exec(value.trim());
  if (!match) throw new Error("Invalid element handle. Use a handle string returned by read_page.");
  return elementHandleSchema.parse({
    tabId: Number(match[1]),
    frameId: Number(match[2]),
    revision: Number(match[3]),
    id: match[4],
  });
}

/** Accepts the documented handle string, or the structured form some models echo back. */
export const handleInputSchema = z.union([
  z.string().transform((value, ctx) => {
    try {
      return parseHandle(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  }),
  elementHandleSchema,
]);

// Blocks omit kind when it is plain "text"; ranking scores stay local to the content script.
export const pageBlockSchema = z.object({
  kind: z.enum(["heading", "list", "table"]).optional(),
  text: z.string(),
});

export const selectOptionSchema = z.object({
  label: z.string(),
  // Omitted when identical to the label or too long to select by value.
  value: z.string().optional(),
  labelTruncated: z.literal(true).optional(),
  disabled: z.literal(true).optional(),
});

export const pageElementSchema = z.object({
  handle: z.string(),
  role: z.string(),
  name: z.string(),
  state: z.record(z.union([z.string(), z.number(), z.boolean()])).optional(),
  options: z.array(selectOptionSchema).optional(),
});
export type PageElement = z.infer<typeof pageElementSchema>;

export const pageSnapshotSchema = z.object({
  tabId: z.number().int(),
  frameId: z.number().int().nonnegative(),
  url: z.string(),
  title: z.string(),
  blocks: z.array(pageBlockSchema),
  elements: z.array(pageElementSchema),
  nextCursor: z.string().nullable(),
  warnings: z.array(z.string()).optional(),
});
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

export const actionClassificationSchema = z.enum([
  "read",
  "navigation",
  "reversible",
  "submission",
  "destructive",
  "unknown",
]);
export type ActionClassification = z.infer<typeof actionClassificationSchema>;

export const actionIntentSchema = z.object({
  id: z.string(),
  runId: z.string(),
  tool: toolNameSchema,
  classification: actionClassificationSchema,
  tabId: z.number().int().optional(),
  frameId: z.number().int().nonnegative().optional(),
  target: z.string().optional(),
  redactedArgs: z.record(z.unknown()),
});
export type ActionIntent = z.infer<typeof actionIntentSchema>;

export const actionRecordSchema = actionIntentSchema.extend({
  status: z.enum(["pending", "approved", "denied", "started", "succeeded", "failed", "unverified"]),
  detail: z.string().optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ActionRecord = z.infer<typeof actionRecordSchema>;

export const toolCallSchema = z.object({
  id: z.string(),
  name: toolNameSchema,
  arguments: z.record(z.unknown()),
});
export type ToolCall = z.infer<typeof toolCallSchema>;

export const pendingConfirmationSchema = z.object({
  intent: actionIntentSchema,
  requestedAt: z.number().int(),
});
export type PendingConfirmation = z.infer<typeof pendingConfirmationSchema>;

export const appSnapshotSchema = z.object({
  settings: appSettingsSchema,
  mode: safetyModeSchema,
  workspace: workspaceRecordSchema,
  messages: z.array(messageRecordSchema),
  modelTurns: z.array(modelTurnRecordSchema),
  notes: z.array(workspaceNoteSchema),
  activeRun: runRecordSchema.nullable(),
  pendingConfirmation: pendingConfirmationSchema.nullable(),
  usage: z.array(tokenUsageSchema),
  hasSiteAccess: z.boolean(),
});
export type AppSnapshot = z.infer<typeof appSnapshotSchema>;

const commandBase = {
  version: z.literal(1),
  requestId: z.string(),
};

export const uiCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...commandBase, type: z.literal("get_state") }),
  z.object({ ...commandBase, type: z.literal("send_message"), text: z.string().trim().min(1).max(50_000) }),
  z.object({ ...commandBase, type: z.literal("stop_run"), runId: z.string().optional() }),
  z.object({
    ...commandBase,
    type: z.literal("confirm_action"),
    actionId: z.string(),
    approved: z.boolean(),
  }),
  z.object({ ...commandBase, type: z.literal("set_mode"), mode: safetyModeSchema }),
  z.object({ ...commandBase, type: z.literal("save_settings"), settings: appSettingsSchema }),
  z.object({
    ...commandBase,
    type: z.literal("set_model"),
    model: z.string().trim().min(1).max(200),
    availableModels: z.array(z.string().trim().min(1).max(200)).max(1_000).optional(),
  }),
  z.object({ ...commandBase, type: z.literal("set_provider"), providerId: z.string() }),
  z.object({ ...commandBase, type: z.literal("test_provider"), provider: providerSettingsSchema }),
  z.object({ ...commandBase, type: z.literal("list_provider_models"), provider: providerConnectionSchema }),
  z.object({ ...commandBase, type: z.literal("request_site_access") }),
  z.object({ ...commandBase, type: z.literal("new_chat") }),
  z.object({
    ...commandBase,
    type: z.literal("new_workspace"),
    name: z.string().trim().min(1).max(80).optional(),
  }),
  z.object({
    ...commandBase,
    type: z.literal("update_note"),
    noteId: z.string(),
    title: z.string().max(120),
    content: z.string().max(20_000),
  }),
  z.object({ ...commandBase, type: z.literal("delete_note"), noteId: z.string() }),
]);
export type UiCommand = z.infer<typeof uiCommandSchema>;

export const agentEventSchema = z.object({
  version: z.literal(1),
  eventId: z.string(),
  runId: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  type: z.enum(["state", "stream_reset", "stream_delta", "notice", "error"]),
  payload: z.unknown(),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

export const contentCommandSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("snapshot"),
    tabId: z.number().int(),
    frameId: z.number().int().nonnegative().default(0),
    query: z.string().max(1_000).default(""),
    mode: z.enum(["all", "text", "controls"]).default("all"),
    cursor: z.string().nullable().default(null),
    maxTokens: z.number().int().min(100).max(TOKEN_LIMITS.maximumPageResult),
  }),
  z.object({ type: z.literal("describe"), handle: handleInputSchema }),
  z.object({
    type: z.literal("act"),
    operationId: z.string().optional(),
    action: z.enum(["click", "fill", "select", "set_checked", "submit"]),
    handle: handleInputSchema,
    value: z.union([z.string(), z.boolean()]).optional(),
  }),
  z.object({
    type: z.literal("wait"),
    operationId: z.string().optional(),
    condition: z.string().trim().min(1).max(500),
    timeoutMs: z.number().int().positive().max(TOKEN_LIMITS.maxWaitMs),
  }),
  z.object({ type: z.literal("cancel_operation"), operationId: z.string() }),
]);
export type ContentCommand = z.infer<typeof contentCommandSchema>;
