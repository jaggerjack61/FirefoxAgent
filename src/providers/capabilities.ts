/**
 * Capability detection and defaults for OpenAI-compatible endpoints.
 * Users may override auto-detected capabilities in settings.
 */

import type { ModelCapabilities, ProviderConfig } from "@/shared/types";

export const DEFAULT_CAPABILITIES: ModelCapabilities = {
  tools: true,
  streaming: true,
  parallelTools: true,
  structuredOutput: true,
  maxContextTokens: 128_000,
};

/**
 * Heuristics for endpoints that commonly lack function calling support
 * (local servers, older models). This is a starting point only — users
 * can override everything.
 */
export function detectCapabilities(config: ProviderConfig): ModelCapabilities {
  const base = config.baseUrl.toLowerCase();
  const model = config.model.toLowerCase();

  let caps: ModelCapabilities = { ...DEFAULT_CAPABILITIES };

  // Local inference servers frequently omit tool calling.
  if (/(localhost|127\.0\.0\.1|:11434|:1234|:8080|:8000)/.test(base)) {
    caps.tools = false;
    caps.streaming = true;
  }
  if (model.includes("gpt-4o-mini") || model.includes("gpt-4.1-mini")) {
    caps.maxContextTokens = 128_000;
  } else if (model.includes("gpt-3.5")) {
    caps.maxContextTokens = 16_000;
  } else if (model.includes("llama") && model.includes("3")) {
    caps.maxContextTokens = 8192;
  } else if (model.includes("deepseek")) {
    // deepseek-chat / deepseek-reasoner: 64K context.
    caps.maxContextTokens = 64_000;
    // The legacy deepseek-reasoner endpoint does not support native
    // function calling; the runtime uses its structured-JSON fallback.
    if (model === "deepseek-reasoner") caps.tools = false;
  }

  return { ...caps, ...config.capabilitiesOverride };
}

export function applyCapabilityOverrides(
  caps: ModelCapabilities,
  overrides: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return overrides ? { ...caps, ...overrides } : caps;
}
