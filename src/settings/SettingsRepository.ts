/**
 * Settings store: WebExtension `storage.local` for settings + a durable
 * copy of the provider config (which contains the API key — kept inside
 * the extension's own storage, never in page-accessible stores).
 */

import type { AppSettings, ProviderConfig } from "@/shared/types";
import type { MemoryStore } from "@/memory/MemoryStore";

export interface SettingsRepository {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    name: "DeepSeek",
    // The provider layer appends /chat/completions (or /responses) to this.
    baseUrl: "https://api.deepseek.com",
    apiKey: "",
    model: "deepseek-chat",
    reasoningEffort: "medium",
    protocol: "chat_completions",
    customHeaders: {},
    temperature: 0.2,
    maxOutputTokens: 2048,
    // deepseek-chat offers a 64K context window.
    contextLimitTokens: 64_000,
    timeoutMs: 60_000,
    endpoints: [],
  },
  mode: "agent",
  limits: {
    maxActionsPerTask: 25,
    maxTabsInspected: 8,
    // 6k chars ≈ 1.5k tokens of page text per snapshot — enough for
    // headlines, key paragraphs, and navigation cues without dominating
    // the context window on every turn.
    maxPageTextChars: 6_000,
    maxSnapshotElements: 120,
    taskTimeoutMs: 10 * 60_000,
  },
  privacy: {
    allowActivePageContent: true,
    allowOtherTabContent: true,
    allowFormValues: false,
    allowSelectedText: true,
    excludeSensitiveFields: true,
  },
  compression: {
    enabled: true,
    keepRecentMessages: 8,
    summarizeThreshold: 24,
  },
  memory: {
    enabled: true,
    autoSummarizePages: true,
  },
  devMode: false,
  searchEngine: "google",
};

export class WebExtensionSettingsRepository implements SettingsRepository {
  constructor(private readonly memory: MemoryStore) {}

  async load(): Promise<AppSettings> {
    const stored = await browser.storage.local.get("settings");
    const provider = await this.memory.loadProvider();
    const saved = stored.settings as Partial<AppSettings> | undefined;
    return mergeSettings(DEFAULT_SETTINGS, saved ?? {}, provider ?? undefined);
  }

  async save(settings: AppSettings): Promise<void> {
    const { provider, ...rest } = settings;
    await browser.storage.local.set({ settings: rest });
    await this.memory.saveProvider(provider);
  }
}

/** Pure merge used by both the repo and tests. */
export function mergeSettings(
  defaults: AppSettings,
  partial: Partial<AppSettings>,
  provider?: ProviderConfig,
): AppSettings {
  const merged: AppSettings = {
    ...defaults,
    ...partial,
    // Merge persisted provider objects with defaults so newly introduced
    // fields are populated when upgrading an existing installation.
    provider: { ...defaults.provider, ...(partial.provider ?? {}), ...(provider ?? {}) },
    limits: { ...defaults.limits, ...(partial.limits ?? {}) },
    privacy: { ...defaults.privacy, ...(partial.privacy ?? {}) },
    compression: { ...defaults.compression, ...(partial.compression ?? {}) },
    memory: { ...defaults.memory, ...(partial.memory ?? {}) },
  };
  return merged;
}
