import { describe, expect, it } from "vitest";
import { contentHash, estimateTokens, lexicalScore, stableStringify, truncateToTokens } from "./token";

describe("token utilities", () => {
  it("uses deterministic conservative estimates", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("hello")).toBe(2);
    expect(estimateTokens("🦊".repeat(100))).toBeGreaterThan(100);
  });

  it("truncates by UTF-8 bytes without exceeding the intended order of magnitude", () => {
    const result = truncateToTokens("word ".repeat(1_000), 40);
    expect(result).toContain("[truncated]");
    expect(estimateTokens(result)).toBeLessThanOrEqual(42);
    expect(truncateToTokens("short", 40)).toBe("short");
  });

  it("serializes and hashes objects stably", () => {
    expect(stableStringify({ z: 1, a: { d: 2, b: 3 } })).toBe('{"a":{"b":3,"d":2},"z":1}');
    expect(contentHash("same")).toBe(contentHash("same"));
    expect(contentHash("same")).not.toBe(contentHash("different"));
  });

  it("ranks lexical overlap locally", () => {
    expect(lexicalScore("firefox token budget", "Firefox has a strict token budget")).toBe(1);
    expect(lexicalScore("firefox token budget", "unrelated page")).toBe(0);
    expect(lexicalScore("to be", "anything")).toBe(0);
  });
});
