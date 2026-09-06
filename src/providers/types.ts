import type {
  ProviderCapabilities,
  ProviderSettings,
  TokenPolicy,
  TokenUsage,
  ToolCall,
} from "@/shared/schema";
import type { CanonicalMessage, PromptCompilation } from "@/context/compiler";
import type { ToolDefinition } from "@/tools/definitions";

export interface ToolResultItem {
  callId: string;
  output: string;
}

export interface ConversationStep {
  text: string;
  toolCalls: ToolCall[];
  toolResults: ToolResultItem[];
  rawResponseOutput?: unknown[];
}

export interface ProviderRequest {
  settings: ProviderSettings;
  compilation: PromptCompilation;
  baseMessages: CanonicalMessage[];
  steps: ConversationStep[];
  tools: readonly ToolDefinition[];
  policy: TokenPolicy;
  requestSequence: number;
  signal: AbortSignal;
}

export interface ProviderUsage {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
  estimated: boolean;
}

export interface ProviderTurnResult {
  text: string;
  toolCalls: ToolCall[];
  rawResponseOutput?: unknown[];
  usage: ProviderUsage;
  incomplete: boolean;
}

export type ProviderStreamEvent =
  { type: "text_delta"; text: string } | { type: "usage"; usage: ProviderUsage };

export interface CompactRequest {
  settings: ProviderSettings;
  messages: CanonicalMessage[];
  steps?: ConversationStep[];
  policy: TokenPolicy;
  signal: AbortSignal;
}

export interface CompactResult {
  content: string;
  opaqueItems?: unknown[];
  usage: ProviderUsage;
}

export interface ProviderAdapter {
  stream(
    request: ProviderRequest,
    onEvent: (event: ProviderStreamEvent) => void,
  ): Promise<ProviderTurnResult>;
  countInput?(request: ProviderRequest): Promise<number>;
  compact?(request: CompactRequest): Promise<CompactResult>;
}

export interface ProviderTestResult {
  capabilities: ProviderCapabilities;
  message: string;
}

export function persistedUsage(
  id: string,
  runId: string,
  requestSequence: number,
  estimatedInput: number,
  usage: ProviderUsage,
  segments: TokenUsage["segments"] = [],
  kind: TokenUsage["kind"] = "request",
): TokenUsage {
  return {
    id,
    runId,
    requestSequence,
    sequence: requestSequence,
    estimatedInput,
    input: usage.input,
    cachedInput: usage.cachedInput,
    cacheWrite: usage.cacheWrite,
    output: usage.output,
    reasoning: usage.reasoning,
    total: usage.total,
    createdAt: Date.now(),
    estimated: usage.estimated,
    kind,
    segments,
  };
}
