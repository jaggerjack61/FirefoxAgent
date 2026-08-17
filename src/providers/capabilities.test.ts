import { describe, it, expect } from "vitest";
import { detectCapabilities, DEFAULT_CAPABILITIES } from "./capabilities";
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
