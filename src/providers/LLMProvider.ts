/**
 * Provider-agnostic LLM interface. All providers (OpenAI-compatible today,
 * others later) implement this contract so the agent never depends on a
 * specific vendor protocol.
 */

import type { LLMRequest, LLMResponse, ModelCapabilities, StreamEvent } from "@/shared/types";

export interface SendOptions {
  signal?: AbortSignal;
  /** Called with stream events when the provider supports streaming. */
  onStream?: (event: StreamEvent) => void;
}

export interface LLMProvider {
  readonly id: string;
  /** Provider name shown in settings/dev view. */
  readonly name: string;

  send(request: LLMRequest, opts?: SendOptions): Promise<LLMResponse>;

  /** Lists available models from the endpoint's /models (OpenAI-compatible). */
  listModels?(signal?: AbortSignal): Promise<string[]>;

  supportsToolCalling(): boolean;
  supportsStreaming(): boolean;
  capabilities(): ModelCapabilities;
}

/** Abstraction mirroring the spec's suggested interface. */
export interface LLMProviderAdapter {
  sendConversation(
    messages: LLMRequest["messages"],
    opts?: { tools?: LLMRequest["tools"]; temperature?: number; maxOutputTokens?: number; signal?: AbortSignal; onStream?: SendOptions["onStream"] },
  ): Promise<LLMResponse>;
  supportsToolCalling(): boolean;
  supportsStreaming(): boolean;
}
