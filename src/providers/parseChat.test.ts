import { describe, it, expect } from "vitest";
import { accumulateChatChunk, createChatStreamAccumulator, finalizeChatStream, parseChatCompletionResponse, parseToolArguments } from "./parseChat";
import type { ChatCompletionsResponse } from "./wireTypes";

describe("parseChatCompletionResponse", () => {
  it("parses a plain text completion", () => {
    const resp: ChatCompletionsResponse = {
      choices: [{ message: { role: "assistant", content: "Hello world" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 3 },
    };
    const parsed = parseChatCompletionResponse(resp);
    expect(parsed.content).toBe("Hello world");
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.finishReason).toBe("stop");
    expect(parsed.usage?.inputTokens).toBe(10);
  });

  it("parses tool calls with JSON arguments", () => {
    const resp: ChatCompletionsResponse = {
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "switch_tab", arguments: '{"tabId": 3}' } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
    };
    const parsed = parseChatCompletionResponse(resp);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("switch_tab");
    expect(parsed.toolCalls[0].arguments).toEqual({ tabId: 3 });
    expect(parsed.finishReason).toBe("tool_calls");
  });

  it("throws on missing choices", () => {
    expect(() => parseChatCompletionResponse({ choices: [] })).toThrow();
  });
});

describe("parseToolArguments", () => {
  it("parses valid JSON", () => {
    expect(parseToolArguments('{"a": 1}')).toEqual({ a: 1 });
  });

  it("recovers arguments wrapped in markdown fences", () => {
    expect(parseToolArguments('```json\n{"tabId": 4}\n```')).toEqual({ tabId: 4 });
  });

  it("recovers arguments embedded in prose", () => {
    expect(parseToolArguments('Here are the args: {"tabId": 5} end.')).toEqual({ tabId: 5 });
  });

  it("returns empty object for empty string", () => {
    expect(parseToolArguments("")).toEqual({});
  });

  it("throws for truly malformed input", () => {
    expect(() => parseToolArguments("not json at all {{{")).toThrow(/malformed/i);
  });
});

describe("streaming accumulation", () => {
  it("accumulates deltas and tool call fragments", () => {
    const acc = createChatStreamAccumulator();
    accumulateChatChunk(acc, { choices: [{ delta: { content: "Hel" } }] });
    accumulateChatChunk(acc, { choices: [{ delta: { content: "lo" } }] });
    const nameChunk = { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "open_tab", arguments: '{"url":' } }] } }] };
    accumulateChatChunk(acc, nameChunk);
    // Split the remaining JSON across chunks to simulate streaming.
    const args = JSON.stringify({ url: "https://x.com" });
    const argsChunk = { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(7) } }] } }] };
    accumulateChatChunk(acc, argsChunk);
    accumulateChatChunk(acc, { choices: [{ delta: {}, finish_reason: "tool_calls" }] });

    const final = finalizeChatStream(acc);
    expect(final.content).toBe("Hello");
    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls[0].arguments).toEqual({ url: "https://x.com" });
    expect(final.finishReason).toBe("tool_calls");
  });
});
