import type { ProviderSettings } from "@/shared/schema";
import { ChatCompletionsAdapter } from "./chat";
import { ResponsesAdapter } from "./responses";
import type { ProviderAdapter } from "./types";

export function createProvider(settings: ProviderSettings): ProviderAdapter {
  return settings.protocol === "responses" ? new ResponsesAdapter() : new ChatCompletionsAdapter();
}

export { listProviderModels, providerOriginPattern } from "./http";
export * from "./types";
