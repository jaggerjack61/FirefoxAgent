import { ContextCompiler } from "@/context/compiler";
import { makeTokenPolicy, type ProviderProtocol, type ProviderSettings } from "@/shared/schema";
import { TOOL_DEFINITIONS } from "@/tools/definitions";
import type { ProviderRequest } from "@/providers";

export function providerRequest(protocol: ProviderProtocol = "responses"): ProviderRequest {
  const settings: ProviderSettings = {
    protocol,
    baseUrl: "https://provider.example/v1",
    apiKey: "secret",
    model: "test-model",
    availableModels: ["test-model"],
    contextWindow: 32_000,
    maxOutputTokens: 2_048,
    maxThinkingTurns: 12,
    capabilities: {
      exactCounting: false,
      explicitCaching: false,
      nativeCompaction: false,
      streamingUsage: false,
    },
  };
  const policy = makeTokenPolicy(settings.contextWindow, settings.maxOutputTokens);
  const compilation = new ContextCompiler().compile({
    runId: "fixture-run",
    sequence: 0,
    policy,
    userRequest: "Summarize the active article.",
    activeTab: { id: 4, title: "Example", url: "https://example.test/article" },
    mode: "agent",
    messages: [],
    notes: [],
    trace: [],
  });
  return {
    settings,
    compilation,
    baseMessages: compilation.messages,
    steps: [],
    tools: TOOL_DEFINITIONS,
    policy,
    requestSequence: 0,
    signal: new AbortController().signal,
  };
}

export function sseResponse(events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
