import { toolCallSchema, type ToolCall } from "@/shared/schema";
import { contentHash, createId, estimateTokens, stableStringify } from "@/shared/token";
import {
  ProviderHttpError,
  checkedFetch,
  isEventStream,
  parseSse,
  providerEndpoint,
  providerHeaders,
  safeJson,
} from "./http";
import { ChatStreamAccumulator } from "./chat";
import type {
  CompactRequest,
  CompactResult,
  ConversationStep,
  ProviderAdapter,
  ProviderRequest,
  ProviderTurnResult,
  ProviderUsage,
} from "./types";

export class ResponsesAdapter implements ProviderAdapter {
  async stream(
    request: ProviderRequest,
    onEvent: Parameters<ProviderAdapter["stream"]>[1],
  ): Promise<ProviderTurnResult> {
    const payload = buildResponsesPayload(request, true);
    const response = await fetchWithDeveloperFallback(
      providerEndpoint(request.settings, "responses"),
      request.settings,
      payload,
      request.signal,
    );

    let text = "";
    let completed: Record<string, unknown> | null = null;
    const outputItems = new Map<number, unknown>();
    let usage = estimatedUsage(request.compilation.plan.estimatedInput);
    // Gateways that translate /responses to Chat Completions upstream often emit
    // chat.completion.chunk events (or a full chat body when they ignore
    // `stream: true`); accept those here so turns are never silently empty.
    const chat = new ChatStreamAccumulator();

    const handleEvent = (event: Record<string, unknown>) => {
      const type = typeof event.type === "string" ? event.type : "";
      if (event.error || type === "error") throw streamError(event);
      if (type === "response.output_text.delta" && typeof event.delta === "string") {
        text += event.delta;
        onEvent({ type: "text_delta", text: event.delta });
      }
      if ((type === "response.output_item.added" || type === "response.output_item.done") && event.item) {
        const index = typeof event.output_index === "number" ? event.output_index : outputItems.size;
        outputItems.set(index, event.item);
      }
      if (type === "response.failed") throw streamError((event.response as Record<string, unknown>) ?? event);
      if (
        (type === "response.completed" || type === "response.incomplete") &&
        event.response &&
        typeof event.response === "object"
      ) {
        completed = event.response as Record<string, unknown>;
        const normalized = normalizeResponsesUsage(completed.usage);
        if (normalized) {
          usage = normalized;
          onEvent({ type: "usage", usage });
        }
      }
      if (Array.isArray(event.choices) || event.usage) {
        for (const fragment of chat.feed(event)) onEvent({ type: "text_delta", text: fragment });
      }
    };

    if (isEventStream(response)) {
      await parseSse(response, (data) => {
        if (data === "[DONE]") return;
        handleEvent(safeJson(data));
      });
    } else {
      const body = safeJson(await response.text());
      if (Array.isArray(body.output)) {
        if (body.status === "failed" || body.error) throw streamError(body);
        handleEvent({
          type: body.status === "incomplete" ? "response.incomplete" : "response.completed",
          response: body,
        });
      } else handleEvent(body);
    }

    const finalResponse = completed as Record<string, unknown> | null;
    const rawOutput =
      finalResponse && Array.isArray(finalResponse.output)
        ? finalResponse.output
        : [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
    let toolCalls = rawOutput.flatMap(parseResponseToolCall);
    if (toolCalls.length === 0) toolCalls = chat.toolCalls();
    if (!text) text = outputText(rawOutput) || chat.text;
    if (usage.estimated && chat.usage) {
      usage = chat.usage;
      onEvent({ type: "usage", usage });
    }
    if (usage.estimated) {
      usage.output = estimateTokens(text + stableStringify(toolCalls));
      usage.total = usage.input + usage.output;
    }
    const status =
      finalResponse && typeof finalResponse.status === "string" ? finalResponse.status : "completed";
    const incomplete = status === "incomplete" || chat.incomplete;
    if (!text.trim() && toolCalls.length === 0 && !incomplete) {
      throw new Error(
        "Provider returned no text or tool calls. Check the API base URL, protocol, and model.",
      );
    }
    return {
      text,
      toolCalls,
      rawResponseOutput: rawOutput.length ? rawOutput : undefined,
      usage,
      incomplete,
    };
  }

  async countInput(request: ProviderRequest): Promise<number> {
    const payload = buildResponsesPayload(request, false);
    delete payload.stream;
    const response = await fetchWithDeveloperFallback(
      providerEndpoint(request.settings, "responses/input_tokens"),
      request.settings,
      payload,
      request.signal,
    );
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.input_tokens !== "number") throw new Error("Provider did not return input_tokens");
    return Math.max(0, Math.floor(body.input_tokens));
  }

  async compact(request: CompactRequest): Promise<CompactResult> {
    const input: unknown[] = request.messages.map(toResponseMessage);
    appendResponseSteps(input, request.steps ?? []);
    const payload: Record<string, unknown> = {
      model: request.settings.model,
      input,
      instructions:
        "Preserve the goal, constraints, observations, completed actions, unresolved work, and source URLs.",
    };
    const response = await fetchWithDeveloperFallback(
      providerEndpoint(request.settings, "responses/compact"),
      request.settings,
      payload,
      request.signal,
    );
    const body = (await response.json()) as Record<string, unknown>;
    const output = Array.isArray(body.output) ? body.output : [];
    return {
      content: "[Provider compaction checkpoint]",
      opaqueItems: output,
      usage: normalizeResponsesUsage(body.usage) ?? estimatedUsage(0),
    };
  }
}

export function buildResponsesPayload(request: ProviderRequest, stream: boolean): Record<string, unknown> {
  const explicitCaching = request.settings.capabilities.explicitCaching;
  const developerBlock: Record<string, unknown> = {
    type: "input_text",
    text: request.compilation.instructions,
  };
  if (explicitCaching) developerBlock.prompt_cache_breakpoint = { mode: "explicit" };

  const input: unknown[] = [
    { type: "message", role: "developer", content: [developerBlock] },
    ...request.baseMessages.map(toResponseMessage),
  ];
  appendResponseSteps(input, request.steps);

  const payload: Record<string, unknown> = {
    model: request.settings.model,
    input,
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            type: "function",
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            // Preserve optional/defaulted tool arguments across compatible endpoints.
            strict: false,
          })),
          tool_choice: "auto",
          parallel_tool_calls: false,
        }
      : {}),
    stream,
    store: false,
    max_output_tokens: request.policy.outputReserve,
    truncation: "disabled",
  };
  if (explicitCaching) {
    payload.prompt_cache_key = contentHash(
      ["browseragent-v1", "browser-tools-v1", request.settings.protocol, request.settings.model].join(":"),
    );
    payload.prompt_cache_options = { mode: "explicit", ttl: "30m" };
  }
  if (request.settings.capabilities.nativeCompaction) {
    payload.context_management = [{ type: "compaction", compact_threshold: request.policy.inputSoftLimit }];
  }
  return payload;
}

function appendResponseSteps(input: unknown[], steps: ConversationStep[]): void {
  for (const step of steps) {
    if (step.rawResponseOutput) {
      input.push(...step.rawResponseOutput);
    } else {
      if (step.text) input.push(toResponseMessage({ role: "assistant", content: step.text }));
      for (const call of step.toolCalls) {
        input.push({
          type: "function_call",
          call_id: call.id,
          name: call.name,
          arguments: stableStringify(call.arguments),
        });
      }
    }
    for (const result of step.toolResults) {
      input.push({ type: "function_call_output", call_id: result.callId, output: result.output });
    }
  }
}

/**
 * Some OpenAI-compatible gateways accept /responses but translate the request to
 * Chat Completions upstream, which rejects the "developer" role. On that specific
 * error, rewrite developer roles to "system" and retry once.
 */
async function fetchWithDeveloperFallback(
  url: string,
  settings: ProviderRequest["settings"],
  payload: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Response> {
  const send = () =>
    checkedFetch(url, {
      method: "POST",
      headers: providerHeaders(settings),
      body: JSON.stringify(payload),
      signal,
    });
  try {
    return await send();
  } catch (error) {
    if (!(error instanceof ProviderHttpError) || !isDeveloperRoleError(error.message)) throw error;
    downgradeDeveloperRoles(payload);
    return send();
  }
}

function streamError(event: Record<string, unknown>): ProviderHttpError {
  const detail = event.error ?? event;
  const message =
    detail && typeof detail === "object" && typeof (detail as Record<string, unknown>).message === "string"
      ? ((detail as Record<string, unknown>).message as string)
      : JSON.stringify(detail);
  return new ProviderHttpError(200, `Provider stream error: ${message}`.slice(0, 500));
}

export function isDeveloperRoleError(message: string): boolean {
  return /developer is not one of|"developer".{0,40}(invalid|not supported|not allowed)/iu.test(message);
}

function downgradeDeveloperRoles(payload: Record<string, unknown>): void {
  if (Array.isArray(payload.input)) {
    payload.input = (payload.input as unknown[]).map((item) => {
      if (item && typeof item === "object" && (item as Record<string, unknown>).role === "developer") {
        return { ...item, role: "system" };
      }
      return item;
    });
  }
}

function toResponseMessage(message: { role: string; content: string }): Record<string, unknown> {
  return {
    type: "message",
    role: message.role,
    content: [{ type: "input_text", text: message.content }],
  };
}

function parseResponseToolCall(item: unknown): ToolCall[] {
  if (!item || typeof item !== "object") return [];
  const call = item as Record<string, unknown>;
  if (call.type !== "function_call" || typeof call.name !== "string") return [];
  return [
    toolCallSchema.parse({
      id: typeof call.call_id === "string" ? call.call_id : createId("call"),
      name: call.name,
      arguments: typeof call.arguments === "string" ? safeJson(call.arguments) : {},
    }),
  ];
}

function outputText(items: unknown[]): string {
  const chunks: string[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string") {
        chunks.push((part as Record<string, unknown>).text as string);
      }
    }
  }
  return chunks.join("");
}

function normalizeResponsesUsage(value: unknown): ProviderUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const inputDetails =
    usage.input_tokens_details && typeof usage.input_tokens_details === "object"
      ? (usage.input_tokens_details as Record<string, unknown>)
      : {};
  const outputDetails =
    usage.output_tokens_details && typeof usage.output_tokens_details === "object"
      ? (usage.output_tokens_details as Record<string, unknown>)
      : {};
  const input = number(usage.input_tokens);
  const output = number(usage.output_tokens);
  return {
    input,
    cachedInput: number(inputDetails.cached_tokens),
    cacheWrite: number(inputDetails.cache_write_tokens),
    output,
    reasoning: number(outputDetails.reasoning_tokens),
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
