/**
 * Provider factory. New protocols (Anthropic, Gemini, ...) are added here
 * behind the same LLMProvider interface.
 */

import type { ProviderConfig } from "@/shared/types";
import type { LLMProvider } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";

export type ProviderKind = "openai-compatible";

export function createProvider(config: ProviderConfig, kind: ProviderKind = "openai-compatible"): LLMProvider {
  switch (kind) {
    case "openai-compatible":
      return new OpenAICompatibleProvider(config);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}
