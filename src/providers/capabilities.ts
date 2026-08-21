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
  // Most OpenAI-compatible cloud providers cache a stable prompt prefix;
  // local servers typically do not. detectCapabilities refines this.
  supportsPromptCaching: true,
  cacheKeyStrategy: "implicit",
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
    // Local servers generally do not implement prompt-cache routing.
    caps.supportsPromptCaching = false;
    caps.cacheKeyStrategy = "implicit";
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
    // DeepSeek caches a stable prefix implicitly (no cache key accepted);
    // it reports prompt_cache_hit_tokens / prompt_cache_miss_tokens.
    caps.supportsPromptCaching = true;
    caps.cacheKeyStrategy = "implicit";
    // The legacy deepseek-reasoner endpoint does not support native
    // function calling; the runtime uses its structured-JSON fallback.
    if (model === "deepseek-reasoner") caps.tools = false;
  }
  // OpenAI GPT-5.6+ supports explicit prompt-cache breakpoints + keys.
  if (isOfficialOpenAIModel(model) && supportsExplicitPromptCaching(model)) {
    caps.supportsPromptCaching = true;
    caps.cacheKeyStrategy = "explicit";
  }

  return { ...caps, ...config.capabilitiesOverride };
}

/** True for models served by the official OpenAI API (gpt-* family). */
function isOfficialOpenAIModel(model: string): boolean {
  return /^gpt-/.test(model);
}

/**
 * OpenAI explicit prompt caching is available on GPT-5.6 and later. The
 * provider sends prompt_cache_key + prompt_cache_breakpoint only for these.
 */
export function supportsExplicitPromptCaching(model: string): boolean {
  const match = model.toLowerCase().match(/^gpt-(\d+)(?:\.(\d+))?/);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

export function applyCapabilityOverrides(
  caps: ModelCapabilities,
  overrides: Partial<ModelCapabilities> | undefined,
): ModelCapabilities {
  return overrides ? { ...caps, ...overrides } : caps;
}
