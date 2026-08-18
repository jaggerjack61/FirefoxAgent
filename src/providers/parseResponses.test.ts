import { describe, it, expect } from "vitest";
import { accumulateResponsesEvent, createResponsesStreamAccumulator, finalizeResponsesStream, parseResponsesResponse } from "./parseResponses";
import type { ResponsesResponse } from "./wireTypes";

describe("parseResponsesResponse", () => {
  it("parses text output", () => {
    const resp: ResponsesResponse = {
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The answer is 42." }],
        },
      ],
      usage: {
        input_tokens: 5,
        output_tokens: 4,
        input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
      },
    };
    const parsed = parseResponsesResponse(resp);
    expect(parsed.content).toBe("The answer is 42.");
    expect(parsed.toolCalls).toEqual([]);
    expect(parsed.usage?.inputTokens).toBe(5);
    expect(parsed.usage).toMatchObject({ cachedInputTokens: 3, cacheMissTokens: 2, cacheWriteTokens: 2 });
  });

  it("parses function calls", () => {
    const resp: ResponsesResponse = {
      output: [
        {
          type: "function_call",
          call_id: "fc_1",
          name: "click_element",
          arguments: '{"elementId": "E3"}',
          status: "completed",
        },
      ],
    };
    const parsed = parseResponsesResponse(resp);
    expect(parsed.toolCalls).toHaveLength(1);
    expect(parsed.toolCalls[0].name).toBe("click_element");
    expect(parsed.toolCalls[0].arguments).toEqual({ elementId: "E3" });
  });
});

describe("responses streaming", () => {
  it("accumulates text and call arguments", () => {
    const acc = createResponsesStreamAccumulator();
    accumulateResponsesEvent(acc, { type: "response.output_text.delta", delta: "Sum" });
    accumulateResponsesEvent(acc, { type: "response.output_text.delta", delta: "mary" });
    accumulateResponsesEvent(acc, {
      type: "response.output_item.added",
      item_id: "fc_2",
      item: { id: "fc_2", type: "function_call", name: "open_tab" },
    } as never);
    accumulateResponsesEvent(acc, { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '{"url": ' });
    accumulateResponsesEvent(acc, { type: "response.function_call_arguments.delta", item_id: "fc_2", delta: '"https://a.io"}' });
    accumulateResponsesEvent(acc, {
      type: "response.completed",
      response: {
        status: "completed",
        usage: {
          input_tokens: 100,
          output_tokens: 12,
          input_tokens_details: { cached_tokens: 80, cache_write_tokens: 16 },
        },
      },
    });

    const final = finalizeResponsesStream(acc);
    expect(final.content).toBe("Summary");
    expect(final.toolCalls).toHaveLength(1);
    expect(final.toolCalls[0].arguments).toEqual({ url: "https://a.io" });
    expect(final.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 12,
      cachedInputTokens: 80,
      cacheMissTokens: 20,
      cacheWriteTokens: 16,
    });
  });
});
