import { describe, it, expect } from "vitest";
import { detectCapabilities, DEFAULT_CAPABILITIES, supportsExplicitPromptCaching } from "./capabilities";
import type { ProviderConfig } from "@/shared/types";

const baseConfig: ProviderConfig = {
  name: "test",
  baseUrl: "https://api.example.com/v1",
  apiKey: "",
  model: "gpt-4o",
  reasoningEffort: "medium",
  protocol: "chat_completions",
  customHeaders: {},
  temperature: 0.2,
  maxOutputTokens: 1000,
  contextLimitTokens: 128_000,
  timeoutMs: 30_000,
};

describe("detectCapabilities", () => {
  it("defaults to full capabilities for cloud endpoints", () => {
    expect(detectCapabilities(baseConfig)).toEqual(DEFAULT_CAPABILITIES);
  });

  it("disables tools for local servers", () => {
    const caps = detectCapabilities({ ...baseConfig, baseUrl: "http://localhost:11434" });
    expect(caps.tools).toBe(false);
  });

  it("caps gpt-3.5 context", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "gpt-3.5-turbo" });
    expect(caps.maxContextTokens).toBe(16_000);
  });

  it("uses structured fallback for legacy deepseek-reasoner", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "deepseek-reasoner" });
    expect(caps.tools).toBe(false);
    expect(caps.maxContextTokens).toBe(64_000);
  });

  it("applies user overrides", () => {
    const caps = detectCapabilities({ ...baseConfig, capabilitiesOverride: { tools: false, streaming: false } });
    expect(caps.tools).toBe(false);
    expect(caps.streaming).toBe(false);
  });
});

describe("prompt caching capabilities", () => {
  it("defaults to implicit prompt caching for cloud endpoints", () => {
    expect(DEFAULT_CAPABILITIES.supportsPromptCaching).toBe(true);
    expect(DEFAULT_CAPABILITIES.cacheKeyStrategy).toBe("implicit");
  });

  it("enables implicit caching for DeepSeek models", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "deepseek-chat" });
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.cacheKeyStrategy).toBe("implicit");
  });

  it("disables prompt caching for local servers", () => {
    const caps = detectCapabilities({ ...baseConfig, baseUrl: "http://localhost:11434" });
    expect(caps.supportsPromptCaching).toBe(false);
    expect(caps.cacheKeyStrategy).toBe("implicit");
  });

  it("uses explicit cache key strategy for GPT-5.6+ models", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "gpt-5.6-sol" });
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.cacheKeyStrategy).toBe("explicit");
  });

  it("uses explicit cache key strategy for GPT-6 and later", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "gpt-6-mini" });
    expect(caps.cacheKeyStrategy).toBe("explicit");
  });

  it("keeps implicit caching for pre-5.6 GPT models", () => {
    const caps = detectCapabilities({ ...baseConfig, model: "gpt-4o" });
    expect(caps.supportsPromptCaching).toBe(true);
    expect(caps.cacheKeyStrategy).toBe("implicit");
  });
});

describe("supportsExplicitPromptCaching", () => {
  it("returns true for GPT-5.6 and later", () => {
    expect(supportsExplicitPromptCaching("gpt-5.6")).toBe(true);
    expect(supportsExplicitPromptCaching("gpt-5.6-sol")).toBe(true);
    expect(supportsExplicitPromptCaching("gpt-6")).toBe(true);
    expect(supportsExplicitPromptCaching("gpt-6.1-mini")).toBe(true);
  });

  it("returns false for pre-5.6 GPT models", () => {
    expect(supportsExplicitPromptCaching("gpt-4o")).toBe(false);
    expect(supportsExplicitPromptCaching("gpt-5")).toBe(false);
    expect(supportsExplicitPromptCaching("gpt-5.5")).toBe(false);
  });

  it("returns false for non-GPT models", () => {
    expect(supportsExplicitPromptCaching("deepseek-chat")).toBe(false);
    expect(supportsExplicitPromptCaching("llama-3")).toBe(false);
    expect(supportsExplicitPromptCaching("claude-3.5-sonnet")).toBe(false);
  });
});
