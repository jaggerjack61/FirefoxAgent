/**
 * OpenAI-compatible provider implementing both wire protocols:
 *  - POST {baseUrl}/chat/completions
 *  - POST {baseUrl}/responses
 *
 * Streaming, tool calls, custom headers and timeouts are supported. Secrets
 * (apiKey, Authorization) are attached only to the outgoing request and
 * never enter page contexts or dev logs.
 */

import type { LLMMessage, LLMRequest, LLMResponse, ModelCapabilities, ProviderConfig, StreamEvent, ToolCall } from "@/shared/types";
import { ToolError } from "@/shared/errors";
import type { LLMProvider, SendOptions } from "./LLMProvider";
import { detectCapabilities } from "./capabilities";
import { AbortError, retryFetch } from "./retry";
import { consumeSseStream, extractJson } from "./sse";
import { redact } from "@/shared/redact";
import {
  accumulateChatChunk,
  createChatStreamAccumulator,
  finalizeChatStream,
  parseChatCompletionResponse,
} from "./parseChat";
import {
  accumulateResponsesEvent,
  createResponsesStreamAccumulator,
  finalizeResponsesStream,
  parseResponsesResponse,
} from "./parseResponses";
import type {
  ChatCompletionsMessage,
  ChatCompletionsRequest,
  ResponsesInputItem,
  ResponsesRequest,
} from "./wireTypes";

const DEFAULT_ATTEMPTS = 3;
const BACKOFF_MS = [600, 1800, 4200];

export class OpenAICompatibleProvider implements LLMProvider {
  readonly id = "openai-compatible";
  readonly name: string;
  private readonly config: ProviderConfig;
  private readonly caps: ModelCapabilities;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.name || "OpenAI-compatible";
    this.caps = detectCapabilities(config);
  }

  supportsToolCalling(): boolean {
    return this.caps.tools;
  }

  supportsStreaming(): boolean {
    return this.caps.streaming;
  }

  capabilities(): ModelCapabilities {
    return this.caps;
  }

  /**
   * Lists models via GET {baseUrl}/models (OpenAI-compatible). The API key
   * is sent like any other provider call — the models endpoint requires it.
   */
  async listModels(signal?: AbortSignal): Promise<string[]> {
    if (!this.config.baseUrl) {
      throw new ToolError("PROVIDER_ERROR", "Provider base URL is not configured.");
    }
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = { ...this.config.customHeaders };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const res = await retryFetch(`${base}/models`, { method: "GET", headers }, {
      attempts: 2,
      backoffMs: [500],
      timeoutMs: 15_000,
      signal,
    });
    if (res.status === 401 || res.status === 403) {
      throw new ToolError("PROVIDER_ERROR", "Provider rejected the API key when listing models (HTTP " + res.status + ").");
    }
    if (!res.ok) {
      throw new ToolError("PROVIDER_ERROR", `Provider returned HTTP ${res.status} for /models`);
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    return (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string").sort();
  }

  async send(request: LLMRequest, opts?: SendOptions): Promise<LLMResponse> {
    if (!this.config.baseUrl) {
      throw new ToolError("PROVIDER_ERROR", "Provider base URL is not configured.");
    }
    const stream = this.supportsStreaming() && !!opts?.onStream;
    try {
      const response =
        this.config.protocol === "responses"
          ? await this.sendResponses(request, stream, opts)
          : await this.sendChatCompletions(request, stream, opts);
      if (stream && opts?.onStream) opts.onStream({ kind: "done", response });
      return response;
    } catch (err) {
      if (err instanceof AbortError) {
        if (opts?.signal?.aborted) throw new ToolError("AGENT_STOPPED", "Request cancelled by user");
        throw new ToolError("REQUEST_TIMEOUT", `Provider request timed out after ${this.config.timeoutMs}ms`);
      }
      if (err instanceof ToolError) throw err;
      throw new ToolError("PROVIDER_ERROR", err instanceof Error ? err.message : String(err));
    }
  }

  // -------------------------------------------------------------------------
  // chat/completions
  // -------------------------------------------------------------------------

  private async sendChatCompletions(request: LLMRequest, stream: boolean, opts?: SendOptions): Promise<LLMResponse> {
    const officialOpenAI = isOfficialOpenAIEndpoint(this.config.baseUrl);
    const explicitCache = officialOpenAI
      && supportsExplicitPromptCaching(this.config.model)
      && request.cacheStablePrefix === true;
    const normalizedMessages = normalizeChatCompletionHistory(request.messages);
    const body: ChatCompletionsRequest = {
      model: this.config.model,
      ...(supportsReasoningEffort(this.config.model) ? { reasoning_effort: this.config.reasoningEffort } : {}),
      // Conversation compression or restored legacy data can split an
      // assistant/tool-call group. Strict providers reject those orphaned
      // tool results, so repair the history at the final wire boundary.
      messages: normalizedMessages.map((message) => toChatMessage(
        message,
        explicitCache && message.role === "system",
      )),
      temperature: request.temperature ?? this.config.temperature,
      max_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      stream,
      ...(stream && supportsStreamUsage(this.config.baseUrl) ? { stream_options: { include_usage: true } } : {}),
      ...(officialOpenAI && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
      ...(explicitCache ? { prompt_cache_options: { mode: "implicit" as const, ttl: "30m" as const } } : {}),
      ...(request.tools?.length ? { tools: request.tools as ChatCompletionsRequest["tools"], tool_choice: "auto" as const } : {}),
      ...(request.jsonMode ? { response_format: { type: "json_object" as const } } : {}),
    };
    const res = await this.fetchJson("/chat/completions", body, stream, opts?.signal);
    if (stream) {
      const acc = createChatStreamAccumulator();      let lastText = "";
      await consumeSseStream(res, (data) => {
        try {
          accumulateChatChunk(acc, JSON.parse(data));
        } catch {
          /* ignore malformed keep-alive chunks */
        }
        if (acc.text.length > lastText.length) {
          opts?.onStream?.({ kind: "text_delta", text: acc.text.slice(lastText.length) });
          lastText = acc.text;
        }
      }, opts?.signal);
      const final = finalizeChatStream(acc);
      if (opts?.onStream && final.toolCalls.length) {
        for (const tc of final.toolCalls) {
          opts.onStream({ kind: "tool_call_delta", callId: tc.id, name: tc.name, argsDelta: JSON.stringify(tc.arguments) });
        }
      }
      return final;
    }
    return parseChatCompletionResponse((await res.json()) as Parameters<typeof parseChatCompletionResponse>[0]);
  }

  // -------------------------------------------------------------------------
  // responses API
  // -------------------------------------------------------------------------

  private async sendResponses(request: LLMRequest, stream: boolean, opts?: SendOptions): Promise<LLMResponse> {
    const officialOpenAI = isOfficialOpenAIEndpoint(this.config.baseUrl);
    const explicitCache = officialOpenAI
      && supportsExplicitPromptCaching(this.config.model)
      && request.cacheStablePrefix === true;
    const systemIdx = request.messages.findIndex((m) => m.role === "system");
    const instructions = systemIdx !== -1 ? request.messages[systemIdx].content : "";
    const input: ResponsesInputItem[] = request.messages.flatMap((m): ResponsesInputItem[] => {
        if (m.role === "system") {
          return explicitCache
            ? [{
                type: "message" as const,
                role: "developer" as const,
                content: [{
                  type: "input_text" as const,
                  text: m.content ?? "",
                  prompt_cache_breakpoint: { mode: "explicit" as const },
                }],
              }]
            : [];
        }
        if (m.role === "tool") {
          return [{ type: "function_call_output" as const, call_id: m.toolCallId ?? "call", output: m.content ?? "" }];
        }
        return [{
          type: "message" as const,
          role: m.role,
          content: [{ type: "input_text" as const, text: m.content ?? "" }],
        }];
      });

    const body: ResponsesRequest = {
      model: this.config.model,
      ...(supportsReasoningEffort(this.config.model) ? { reasoning: { effort: this.config.reasoningEffort } } : {}),
      input,
      temperature: request.temperature ?? this.config.temperature,
      max_output_tokens: request.maxOutputTokens ?? this.config.maxOutputTokens,
      stream,
      ...(!explicitCache && instructions ? { instructions } : {}),
      ...(officialOpenAI && request.cacheKey ? { prompt_cache_key: request.cacheKey } : {}),
      ...(explicitCache ? { prompt_cache_options: { mode: "implicit" as const, ttl: "30m" as const } } : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((t) => ({
              type: "function" as const,
              name: t.function.name,
              description: t.function.description,
              parameters: t.function.parameters as Record<string, unknown>,
            })),
          }
        : {}),
    };
    const res = await this.fetchJson("/responses", body, stream, opts?.signal);
    if (stream) {
      const acc = createResponsesStreamAccumulator();      let lastText = "";
      await consumeSseStream(res, (data) => {
        try {
          accumulateResponsesEvent(acc, JSON.parse(data));
        } catch {
          /* ignore malformed chunks */
        }
        if (acc.text.length > lastText.length) {
          opts?.onStream?.({ kind: "text_delta", text: acc.text.slice(lastText.length) });
          lastText = acc.text;
        }
      }, opts?.signal);
      const final = finalizeResponsesStream(acc);
      if (opts?.onStream && final.content) opts.onStream({ kind: "text_delta", text: final.content });
      return final;
    }
    return parseResponsesResponse((await res.json()) as Parameters<typeof parseResponsesResponse>[0]);
  }

  // -------------------------------------------------------------------------
  // transport
  // -------------------------------------------------------------------------

  private async fetchJson(path: string, body: unknown, _stream: boolean, signal?: AbortSignal): Promise<Response> {
    const base = this.config.baseUrl.replace(/\/+$/, "");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.config.customHeaders,
    };
    if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

    const res = await retryFetch(`${base}${path}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, {
      attempts: DEFAULT_ATTEMPTS,
      backoffMs: BACKOFF_MS,
      timeoutMs: this.config.timeoutMs,
      signal,
    });
    if (!res.ok) {
      const detail = await providerErrorDetail(res);
      const suffix = detail ? `: ${detail}` : "";
      if (res.status === 401 || res.status === 403) {
        throw new ToolError("PROVIDER_ERROR", `Provider rejected credentials (HTTP ${res.status}). Check the API key and base URL.${suffix}`);
      }
      if (res.status === 429) throw new ToolError("RATE_LIMITED", `Provider rate-limited the request (HTTP 429)${suffix}`, { retryable: true });
      throw new ToolError("PROVIDER_ERROR", `Provider returned HTTP ${res.status} for ${path}${suffix}`);
    }
    return res;
  }
}

function toChatMessage(m: LLMRequest["messages"][number], cacheBreakpoint = false): ChatCompletionsMessage {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content ?? null,
      tool_calls: m.toolCalls.map((tc: ToolCall) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
      })),
    };
  }
  if (m.role === "tool") {
    return { role: "tool", content: m.content ?? "", tool_call_id: m.toolCallId };
  }
  return {
    role: m.role,
    content: cacheBreakpoint
      ? [{ type: "text", text: m.content ?? "", prompt_cache_breakpoint: { mode: "explicit" } }]
      : (m.content ?? ""),
    tool_call_id: m.toolCallId,
    name: m.name,
  };
}

/**
 * Keeps only complete assistant tool-call groups. A tool result is valid only
 * when it immediately follows the assistant turn that declared its call id.
 */
export function normalizeChatCompletionHistory(messages: LLMMessage[]): LLMMessage[] {
  const normalized: LLMMessage[] = [];

  for (let index = 0; index < messages.length;) {
    const message = messages[index];
    if (message.role === "tool") {
      // Orphaned tool result (often the first item after history trimming).
      index += 1;
      continue;
    }

    if (message.role !== "assistant" || !message.toolCalls?.length) {
      normalized.push(message);
      index += 1;
      continue;
    }

    let next = index + 1;
    const responses = new Map<string, LLMMessage>();
    while (next < messages.length && messages[next].role === "tool") {
      const response = messages[next];
      if (response.toolCallId && !responses.has(response.toolCallId)) {
        responses.set(response.toolCallId, response);
      }
      next += 1;
    }

    const calls = message.toolCalls.filter((call) => responses.has(call.id));
    if (calls.length > 0) {
      normalized.push({ ...message, toolCalls: calls });
      for (const call of calls) normalized.push(responses.get(call.id)!);
    } else if (message.content?.trim()) {
      normalized.push({ ...message, toolCalls: undefined });
    }
    index = next;
  }

  return normalized;
}

async function providerErrorDetail(response: Response): Promise<string> {
  try {
    const raw = (await response.text()).trim();
    if (!raw) return "";
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const candidate = parsed.error?.message ?? parsed.message;
      if (typeof candidate === "string") detail = candidate;
    } catch {
      // Plain-text and HTML provider errors are still useful after truncation.
    }
    return String(redact(detail)).replace(/\s+/g, " ").slice(0, 500);
  } catch {
    return "";
  }
}

/** OpenAI-style reasoning controls are rejected by many compatible APIs. */
function supportsReasoningEffort(model: string): boolean {
  return /^(?:gpt-5(?:[.\-]|$)|o[1-9](?:[.\-]|$)|.*codex(?:[.\-]|$))/i.test(model);
}

function isOfficialOpenAIEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.openai.com";
  } catch {
    return false;
  }
}

function supportsStreamUsage(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "api.openai.com" || host === "api.deepseek.com" || host.endsWith(".deepseek.com");
  } catch {
    return false;
  }
}

/** GPT-5.6 and later use explicit prompt-cache breakpoints. */
function supportsExplicitPromptCaching(model: string): boolean {
  const match = model.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/** Parses a structured-output fallback payload from non-tool models. */
export function parseStructuredToolOutput(content: string): { reply?: string; toolCalls?: ToolCall[] } {
  let parsed: unknown;
  try {
    parsed = extractJson(content);
  } catch {
    return { reply: content };
  }
  if (typeof parsed === "string") return { reply: parsed };
  const obj = parsed as { reply?: unknown; tool_calls?: unknown };
  const toolCalls = Array.isArray(obj.tool_calls)
    ? (obj.tool_calls as { name?: string; arguments?: unknown }[])
        .filter((t) => typeof t.name === "string")
        .map((t) => ({
          id: `call_${Math.random().toString(36).slice(2, 10)}`,
          name: t.name as string,
          arguments: (t.arguments ?? {}) as Record<string, unknown>,
        }))
    : [];
  return { reply: typeof obj.reply === "string" ? obj.reply : undefined, toolCalls };
}

/** System prompt suffix used when the model lacks native tool calling. */
export function structuredOutputInstruction(): string {
  return [
    "",
    "=== OUTPUT FORMAT (STRICT JSON MODE) ===",
    "You have no native function-calling support. Respond ONLY with one of:",
    '{"reply": "your final answer to the user"}',
    '{"tool_calls": [{"name": "tool_name", "arguments": {"param": "value"}}]}',
    "You may include multiple tool_calls in one response; they execute in order.",
    "NEVER output anything other than this JSON.",
  ].join("\n");
}

export type { LLMResponse, StreamEvent };
