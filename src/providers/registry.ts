/**
 * Provider factory. New protocols (Anthropic, Gemini, ...) are added here
 * behind the same LLMProvider interface.
 *
 * Multi-endpoint routing: when a ProviderConfig carries an `endpoints` list,
 * createProvider returns a RoutingProvider that sends each model request to
 * the endpoint which lists that model, falling back to the top-level
 * baseUrl/apiKey for unlisted models.
 */

import type { ModelCapabilities, ProviderConfig, ProviderEndpoint } from "@/shared/types";
import type { LLMProvider, SendOptions } from "./LLMProvider";
import { OpenAICompatibleProvider } from "./OpenAICompatibleProvider";
import type { LLMRequest, LLMResponse } from "@/shared/types";

export type ProviderKind = "openai-compatible";

export function createProvider(config: ProviderConfig, kind: ProviderKind = "openai-compatible"): LLMProvider {
  switch (kind) {
    case "openai-compatible":
      return config.endpoints?.length
        ? new RoutingProvider(config)
        : new OpenAICompatibleProvider(config);
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unknown provider kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Routes each model request to the endpoint that serves that model. The
 * top-level provider config acts as the fallback for models not listed on
 * any endpoint, preserving the single-provider behaviour when no endpoints
 * are configured.
 */
export class RoutingProvider implements LLMProvider {
  readonly id = "routing";
  readonly name: string;
  private readonly fallback: LLMProvider;
  private readonly endpoints: Array<{ endpoint: ProviderEndpoint; provider: LLMProvider }>;

  constructor(config: ProviderConfig) {
    this.name = config.name || "Multi-provider";
    this.fallback = new OpenAICompatibleProvider(config);
    this.endpoints = (config.endpoints ?? []).map((endpoint) => ({
      endpoint,
      provider: new OpenAICompatibleProvider({
        ...config,
        name: endpoint.name || config.name,
        baseUrl: endpoint.baseUrl,
        apiKey: endpoint.apiKey,
        protocol: endpoint.protocol,
        customHeaders: endpoint.customHeaders,
        timeoutMs: endpoint.timeoutMs,
      }),
    }));
  }

  /** Resolves the provider that should serve the given model. */
  private resolve(model?: string): LLMProvider {
    if (!model) return this.fallback;
    // Prefer an endpoint that explicitly lists the model; otherwise fall
    // back to the first endpoint that serves any model (empty list).
    const explicit = this.endpoints.find(({ endpoint }) => endpoint.models.includes(model));
    if (explicit) return explicit.provider;
    const anyModel = this.endpoints.find(({ endpoint }) => endpoint.models.length === 0);
    return anyModel?.provider ?? this.fallback;
  }

  /** The endpoint (if any) that serves the given model. */
  endpointFor(model?: string): ProviderEndpoint | undefined {
    if (!model) return undefined;
    const explicit = this.endpoints.find(({ endpoint }) => endpoint.models.includes(model));
    if (explicit) return explicit.endpoint;
    return this.endpoints.find(({ endpoint }) => endpoint.models.length === 0)?.endpoint;
  }

  send(request: LLMRequest, opts?: SendOptions): Promise<LLMResponse> {
    return this.resolve(request.model).send(request, opts);
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    // Aggregate models across all endpoints, deduplicated and sorted.
    const lists = await Promise.all(
      this.endpoints.map(({ provider }) => (provider.listModels ? provider.listModels(signal) : Promise.resolve([] as string[]))),
    );
    const fallback = this.fallback.listModels ? await this.fallback.listModels(signal) : [];
    return [...new Set([...fallback, ...lists.flat()])].sort();
  }

  supportsToolCalling(model?: string): boolean {
    return this.resolve(model).supportsToolCalling(model);
  }

  supportsStreaming(model?: string): boolean {
    return this.resolve(model).supportsStreaming(model);
  }

  capabilities(model?: string): ModelCapabilities {
    return this.resolve(model).capabilities(model);
  }
}

