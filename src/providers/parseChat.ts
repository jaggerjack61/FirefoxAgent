/**
 * Parsing of OpenAI-compatible chat completions responses (streamed and
 * non-streamed), including recovery from malformed tool-call arguments.
 */

import type { LLMResponse, ToolCall } from "@/shared/types";
import { ToolError } from "@/shared/errors";
import type { ChatCompletionsChunk, ChatCompletionsResponse, ChatCompletionsToolCall } from "./wireTypes";

export interface ChatStreamAccumulator {
  text: string;
  toolCalls: Map<number, { id?: string; name?: string; args: string }>;
  finishReason: string;
}

export function createChatStreamAccumulator(): ChatStreamAccumulator {
  return { text: "", toolCalls: new Map(), finishReason: "stop" };
}

/** Accumulates one SSE chunk into the accumulator. */
export function accumulateChatChunk(acc: ChatStreamAccumulator, chunk: ChatCompletionsChunk): void {
  const choice = chunk.choices?.[0];
  if (!choice) return;
  const { delta, finish_reason } = choice;
  if (finish_reason) acc.finishReason = finish_reason;
  if (delta?.content) acc.text += delta.content;
  for (const tc of delta?.tool_calls ?? []) {
    let entry = acc.toolCalls.get(tc.index);
    if (!entry) {
      entry = { args: "" };
      acc.toolCalls.set(tc.index, entry);
    }
    if (tc.id) entry.id = tc.id;
    if (tc.function?.name) entry.name = tc.function.name;
    if (tc.function?.arguments) entry.args += tc.function.arguments;
  }
}

/** Parses tool-call arguments JSON with recovery strategies. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through to recovery */
  }
  // Some models wrap arguments in markdown or prepend prose.
  const fenced = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
      if (parsed !== null && typeof parsed === "object") return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  throw new ToolError("MODEL_MALFORMED_OUTPUT", `Model returned malformed tool arguments: ${truncateForError(raw)}`, {
    suggestedAction: "Ask the model to retry with valid JSON arguments.",
  });
}

function truncateForError(s: string): string {
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function toToolCalls(calls: ChatCompletionsToolCall[] | undefined): ToolCall[] {
  if (!calls) return [];
  return calls.map((c) => ({
    id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
    name: c.function.name,
    arguments: parseToolArguments(c.function.arguments),
  }));
}

const finishMapping: Record<string, LLMResponse["finishReason"]> = {
  stop: "stop",
  tool_calls: "tool_calls",
  length: "length",
  content_filter: "content_filter",
};

export function parseChatCompletionResponse(data: ChatCompletionsResponse): LLMResponse {
  const choice = data.choices?.[0];
  if (!choice) throw new ToolError("MODEL_MALFORMED_OUTPUT", "Provider returned no choices");
  const content = choice.message.content;
  return {
    content: Array.isArray(content) ? content.map((c) => c.text).join("") : (content ?? null),
    toolCalls: toToolCalls(choice.message.tool_calls),
    finishReason: finishMapping[choice.finish_reason] ?? "stop",
    usage: data.usage
      ? { inputTokens: data.usage.prompt_tokens, outputTokens: data.usage.completion_tokens }
      : undefined,
  };
}

export function finalizeChatStream(acc: ChatStreamAccumulator): LLMResponse {
  const toolCalls: ToolCall[] = [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, e]) => e.name)
    .map(([, e]) => ({
      id: e.id ?? `call_${Math.random().toString(36).slice(2, 10)}`,
      name: e.name!,
      arguments: parseToolArguments(e.args),
    }));
  return {
    content: acc.text || null,
    toolCalls,
    finishReason: finishMapping[acc.finishReason] ?? (toolCalls.length ? "tool_calls" : "stop"),
  };
}
