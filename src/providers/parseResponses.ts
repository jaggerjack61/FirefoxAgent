/**
 * Parsing for the OpenAI Responses API (`/v1/responses`), streamed and
 * non-streamed. Maps its output items onto the provider-agnostic LLMResponse.
 */

import type { LLMResponse, LLMUsage, ToolCall } from "@/shared/types";
import { ToolError } from "@/shared/errors";
import type { ResponsesResponse, ResponsesStreamEvent, ResponsesUsage } from "./wireTypes";
import { parseToolArguments } from "./parseChat";

export interface ResponsesStreamAccumulator {
  text: string;
  /** call_id -> { name, args } */
  toolCalls: Map<string, { name?: string; args: string }>;
  status: string;
  usage?: LLMUsage;
}

export function createResponsesStreamAccumulator(): ResponsesStreamAccumulator {
  return { text: "", toolCalls: new Map(), status: "in_progress" };
}

const isFunctionCallItem = (item: { type?: string }): boolean => item.type === "function_call";

export function accumulateResponsesEvent(
  acc: ResponsesStreamAccumulator,
  event: ResponsesStreamEvent,
): void {
  switch (event.type) {
    case "response.output_text.delta":
      if (event.delta) acc.text += event.delta;
      break;
    case "response.function_call_arguments.delta": {
      const callId = event.item_id ?? "call";
      let entry = acc.toolCalls.get(callId);
      if (!entry) {
        entry = { args: "" };
        acc.toolCalls.set(callId, entry);
      }
      if (event.delta) entry.args += event.delta;
      break;
    }
    case "response.function_call_arguments.done":
      if (event.item_id) {
        let entry = acc.toolCalls.get(event.item_id);
        if (!entry) {
          entry = { args: "" };
          acc.toolCalls.set(event.item_id, entry);
        }
        if (event.arguments) entry.args = event.arguments;
      }
      break;
    case "response.output_item.added": {
      // Captures the call name when the item is announced.
      const item = event as unknown as { item?: { id?: string; type?: string; name?: string } };
      if (item.item && isFunctionCallItem(item.item) && item.item.id) {
        acc.toolCalls.set(item.item.id, { name: item.item.name, args: "" });
      }
      break;
    }
    case "response.completed":
      acc.status = event.response?.status ?? "completed";
      acc.usage = parseResponsesUsage(event.response?.usage);
      break;
  }
}

export function finalizeResponsesStream(acc: ResponsesStreamAccumulator): LLMResponse {
  const toolCalls: ToolCall[] = [...acc.toolCalls.entries()].map(([id, e]) => ({
    id,
    name: e.name ?? "",
    arguments: parseToolArguments(e.args),
  }));
  if (toolCalls.some((t) => !t.name)) {
    throw new ToolError("MODEL_MALFORMED_OUTPUT", "Streamed function call is missing a name", {
      suggestedAction: "Ask the model to retry.",
    });
  }
  return {
    content: acc.text || null,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: acc.usage,
  };
}

export function parseResponsesResponse(data: ResponsesResponse): LLMResponse {
  const textParts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const item of data.output ?? []) {
    if (item.type === "message") {
      for (const c of item.content) if (c.type === "output_text") textParts.push(c.text);
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: parseToolArguments(item.arguments),
      });
    }
  }
  return {
    content: textParts.length ? textParts.join("") : null,
    toolCalls,
    finishReason: toolCalls.length ? "tool_calls" : "stop",
    usage: parseResponsesUsage(data.usage),
  };
}

function parseResponsesUsage(usage: ResponsesUsage | undefined): LLMUsage | undefined {
  if (!usage) return undefined;
  const cachedInputTokens = usage.input_tokens_details?.cached_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens,
    cacheMissTokens: usage.input_tokens !== undefined && cachedInputTokens !== undefined
      ? Math.max(0, usage.input_tokens - cachedInputTokens)
      : undefined,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens,
  };
}
