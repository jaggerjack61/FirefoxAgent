import { toolCallSchema, type ToolCall } from "@/shared/schema";
import { createId, estimateTokens, stableStringify } from "@/shared/token";
import {
  checkedFetch,
  isEventStream,
  parseSse,
  providerEndpoint,
  providerHeaders,
  ProviderHttpError,
  safeJson,
} from "./http";
import type {
  CompactRequest,
  CompactResult,
  ProviderAdapter,
  ProviderRequest,
  ProviderTurnResult,
  ProviderUsage,
} from "./types";

interface AccumulatedTool {
  id: string;
  name: string;
  arguments: string;
}

/**
 * Accumulates Chat Completions events. Accepts both streamed SSE chunks
 * (choices[].delta) and complete non-streaming bodies (choices[].message), so
 * gateways that ignore `stream: true` still produce output. Reasoning models
 * put visible thinking in `reasoning_content` (or `reasoning`); it is streamed
 * as commentary so the UI is never blank, but kept out of `text`, which is
 * replayed to the model on every later turn and becomes the final answer.
 */
export class ChatStreamAccumulator {
  text = "";
  reasoning = "";
  incomplete = false;
  usage: ProviderUsage | null = null;
  private readonly calls = new Map<number, AccumulatedTool>();

  /** Feed one parsed event; returns text fragments the caller should emit. */
  feed(event: Record<string, unknown>): string[] {
    const deltas: string[] = [];
    if (event.error) {
      const detail = event.error as Record<string, unknown>;
      const message = typeof detail.message === "string" ? detail.message : JSON.stringify(detail);
      throw new ProviderHttpError(200, `Provider stream error: ${message}`.slice(0, 500));
    }
    const eventUsage = normalizeChatUsage(event.usage);
    if (eventUsage) this.usage = eventUsage;
    for (const choice of Array.isArray(event.choices) ? event.choices : []) {
      if (!choice || typeof choice !== "object") continue;
      const record = choice as Record<string, unknown>;
      if (record.finish_reason === "length") this.incomplete = true;
      const delta = (record.delta ?? record.message) as Record<string, unknown> | undefined;
      if (!delta || typeof delta !== "object") continue;
      // Some gateways mirror the same thinking into both fields; take one.
      const thinking = [delta.reasoning_content, delta.reasoning].find(
        (chunk): chunk is string => typeof chunk === "string" && chunk.length > 0,
      );
      if (thinking) {
        this.reasoning += thinking;
        deltas.push(thinking);
      }
      if (typeof delta.content === "string" && delta.content) {
        this.text += delta.content;
        deltas.push(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const item of delta.tool_calls) {
          if (!item || typeof item !== "object") continue;
          const chunk = item as Record<string, unknown>;
          const index = typeof chunk.index === "number" ? chunk.index : this.calls.size;
          const existing = this.calls.get(index) ?? { id: "", name: "", arguments: "" };
          if (typeof chunk.id === "string") existing.id += chunk.id;
          const fn = chunk.function;
          if (fn && typeof fn === "object") {
            const functionChunk = fn as Record<string, unknown>;
            if (typeof functionChunk.name === "string") existing.name += functionChunk.name;
            if (typeof functionChunk.arguments === "string") existing.arguments += functionChunk.arguments;
          }
          this.calls.set(index, existing);
        }
      }
    }
    return deltas;
  }

  toolCalls(): ToolCall[] {
    return [...this.calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => parseCall(call));
  }
}

export class ChatCompletionsAdapter implements ProviderAdapter {
  async stream(
    request: ProviderRequest,
    onEvent: Parameters<ProviderAdapter["stream"]>[1],
  ): Promise<ProviderTurnResult> {
    const payload = buildChatPayload(request);
    const response = await fetchChat(request, payload);

    const accumulator = new ChatStreamAccumulator();
    const emit = (fragments: string[]) => {
      for (const fragment of fragments) onEvent({ type: "text_delta", text: fragment });
    };

    if (isEventStream(response)) {
      await parseSse(response, (data) => {
        if (data === "[DONE]") return;
        emit(accumulator.feed(safeJson(data)));
      });
    } else {
      // Gateway ignored `stream: true` and returned a complete completion.
      emit(accumulator.feed(safeJson(await response.text())));
    }

    let usage = accumulator.usage ?? estimatedUsage(request.compilation.plan.estimatedInput);
    if (accumulator.usage) onEvent({ type: "usage", usage: accumulator.usage });
    const toolCalls = accumulator.toolCalls();
    // A reasoning-only final turn still answers the user rather than failing the run.
    const text = accumulator.text.trim() || toolCalls.length > 0 ? accumulator.text : accumulator.reasoning;
    if (!text.trim() && toolCalls.length === 0 && !accumulator.incomplete) {
      throw new Error(
        "Provider returned no text or tool calls. Check the API base URL, protocol, and model.",
      );
    }
    if (usage.estimated) {
      const output = estimateTokens(accumulator.reasoning + accumulator.text + stableStringify(toolCalls));
      usage = { ...usage, output, total: usage.input + output };
    }
    return {
      text,
      ...(accumulator.reasoning ? { reasoning: accumulator.reasoning } : {}),
      toolCalls,
      usage,
      incomplete: accumulator.incomplete,
    };
  }

  async compact(request: CompactRequest): Promise<CompactResult> {
    const response = await fetchChat(request, {
      model: request.settings.model,
      stream: false,
      max_tokens: 700,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Compact the conversation into JSON with keys goal,constraints,observations,actions,unresolved,sources. Preserve facts and URLs. Maximum 700 tokens.",
        },
        ...request.messages.map(toChatMessage),
      ],
    });
    const body = (await response.json()) as Record<string, unknown>;
    const choices = Array.isArray(body.choices) ? body.choices : [];
    const first = choices[0] as Record<string, unknown> | undefined;
    const message = first?.message as Record<string, unknown> | undefined;
    const content = typeof message?.content === "string" ? message.content : "{}";
    return {
      content,
      usage: normalizeChatUsage(body.usage) ?? estimatedUsage(0),
    };
  }
}

export function buildChatPayload(request: ProviderRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: request.compilation.instructions },
    ...request.baseMessages.map(toChatMessage),
  ];
  for (const step of request.steps) {
    messages.push({
      role: "assistant",
      content: step.text || null,
      // An empty tool_calls array is rejected by several endpoints.
      ...(step.toolCalls.length
        ? {
            tool_calls: step.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: stableStringify(call.arguments) },
            })),
          }
        : {}),
    });
    for (const result of step.toolResults) {
      messages.push({ role: "tool", tool_call_id: result.callId, content: result.output });
    }
  }
  return {
    model: request.settings.model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: request.policy.outputReserve,
    messages,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              // Optional/defaulted arguments are validated locally, not a strict all-required schema.
              strict: false,
            },
          })),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }
      : {}),
  };
}

/** Keep legacy gateway compatibility, but honor models that explicitly require the newer token limit. */
async function fetchChat(
  request: Pick<ProviderRequest, "settings" | "signal">,
  payload: Record<string, unknown>,
): Promise<Response> {
  const send = () =>
    checkedFetch(providerEndpoint(request.settings, "chat/completions"), {
      method: "POST",
      headers: providerHeaders(request.settings),
      body: JSON.stringify(payload),
      signal: request.signal,
    });
  try {
    return await send();
  } catch (error) {
    // Retry only an explicit request validation error, never a network/stream failure:
    // those may already have generated output and incurred usage.
    if (
      !(error instanceof ProviderHttpError) ||
      error.status !== 400 ||
      !/\bmax_tokens\b/iu.test(error.message) ||
      !/\bmax_completion_tokens\b/iu.test(error.message) ||
      !/unsupported|not supported|not compatible/iu.test(error.message)
    ) {
      throw error;
    }
    payload.max_completion_tokens = payload.max_tokens;
    delete payload.max_tokens;
    return send();
  }
}

function toChatMessage(message: { role: string; content: string }): Record<string, unknown> {
  // Chat Completions endpoints only accept system/assistant/user/tool/function roles.
  // The context compiler emits "developer" messages (checkpoints, memory, run state);
  // map them to "system" which is the closest supported equivalent.
  return { ...message, role: message.role === "developer" ? "system" : message.role };
}

function parseCall(call: AccumulatedTool): ToolCall {
  const parsed = safeJson(call.arguments);
  return toolCallSchema.parse({
    id: call.id || createId("call"),
    name: call.name,
    arguments: parsed,
  });
}

function normalizeChatUsage(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const details =
    usage.prompt_tokens_details && typeof usage.prompt_tokens_details === "object"
      ? (usage.prompt_tokens_details as Record<string, unknown>)
      : {};
  const input = number(usage.prompt_tokens);
  const output = number(usage.completion_tokens);
  const reasoningDetails =
    usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? (usage.completion_tokens_details as Record<string, unknown>)
      : {};
  return {
    input,
    cachedInput: number(details.cached_tokens),
    cacheWrite: number(details.cache_write_tokens),
    output,
    reasoning: number(reasoningDetails.reasoning_tokens),
    total: number(usage.total_tokens) || input + output,
    estimated: false,
  };
}

function estimatedUsage(input: number): ProviderUsage {
  return { input, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: input, estimated: true };
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
