import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  estimateTokensMemoized,
  countMessageTokens,
  sumMessageTokens,
  MESSAGE_OVERHEAD_TOKENS,
} from "./tokens";
import type { LLMMessage } from "./types";

describe("estimateTokens", () => {
  it("returns 0 for empty/null/undefined input", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens(null)).toBe(0);
    expect(estimateTokens(undefined)).toBe(0);
  });

  it("estimates roughly 4 chars per token (ceil)", () => {
    // 8 chars → 2 tokens
    expect(estimateTokens("12345678")).toBe(2);
    // 9 chars → 3 tokens (ceil)
    expect(estimateTokens("123456789")).toBe(3);
  });

  it("always returns at least 1 for non-empty text", () => {
    expect(estimateTokens("a")).toBe(1);
  });
});

describe("estimateTokensMemoized", () => {
  it("returns the same value as estimateTokens", () => {
    const text = "some reasonably long string to estimate";
    expect(estimateTokensMemoized(text)).toBe(estimateTokens(text));
  });

  it("caches repeated calls (returns identical results)", () => {
    const text = "cached content repeated across turns";
    const first = estimateTokensMemoized(text);
    const second = estimateTokensMemoized(text);
    expect(first).toBe(second);
    expect(first).toBeGreaterThan(0);
  });

  it("returns 0 for empty/null/undefined input", () => {
    expect(estimateTokensMemoized("")).toBe(0);
    expect(estimateTokensMemoized(null)).toBe(0);
    expect(estimateTokensMemoized(undefined)).toBe(0);
  });
});

describe("countMessageTokens", () => {
  it("adds per-message overhead on top of content tokens", () => {
    const msg: LLMMessage = { role: "user", content: "hello world" };
    const contentTokens = estimateTokensMemoized("hello world");
    expect(countMessageTokens(msg)).toBe(contentTokens + MESSAGE_OVERHEAD_TOKENS);
  });

  it("counts tool calls as name + serialized arguments", () => {
    const args = { selector: "E3", wait: 500 };
    const msg: LLMMessage = {
      role: "assistant",
      content: null,
      toolCalls: [{ id: "c1", name: "click_element", arguments: args }],
    };
    const expected =
      estimateTokensMemoized(null) +
      estimateTokensMemoized(`click_element:${JSON.stringify(args)}`) +
      MESSAGE_OVERHEAD_TOKENS;
    expect(countMessageTokens(msg)).toBe(expected);
  });

  it("counts multiple tool calls", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: "doing two things",
      toolCalls: [
        { id: "c1", name: "list_tabs", arguments: {} },
        { id: "c2", name: "get_page_snapshot", arguments: { tabId: 1 } },
      ],
    };
    const tokens = countMessageTokens(msg);
    expect(tokens).toBeGreaterThan(MESSAGE_OVERHEAD_TOKENS);
    // Should include content + both tool calls.
    expect(tokens).toBe(
      estimateTokensMemoized("doing two things") +
        estimateTokensMemoized("list_tabs:{}") +
        estimateTokensMemoized(`get_page_snapshot:${JSON.stringify({ tabId: 1 })}`) +
        MESSAGE_OVERHEAD_TOKENS,
    );
  });

  it("handles null content", () => {
    const msg: LLMMessage = { role: "assistant", content: null };
    expect(countMessageTokens(msg)).toBe(MESSAGE_OVERHEAD_TOKENS);
  });
});

describe("sumMessageTokens", () => {
  it("sums tokens across multiple messages", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const expected = countMessageTokens(messages[0]) + countMessageTokens(messages[1]);
    expect(sumMessageTokens(messages)).toBe(expected);
  });

  it("returns 0 for an empty list", () => {
    expect(sumMessageTokens([])).toBe(0);
  });

  it("scales with message count", () => {
    const one: LLMMessage[] = [{ role: "user", content: "same content" }];
    const two: LLMMessage[] = [
      { role: "user", content: "same content" },
      { role: "user", content: "same content" },
    ];
    expect(sumMessageTokens(two)).toBeGreaterThan(sumMessageTokens(one));
    expect(sumMessageTokens(two)).toBe(sumMessageTokens(one) * 2);
  });
});
