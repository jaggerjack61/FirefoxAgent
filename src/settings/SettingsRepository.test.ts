import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/shared/types";
import { DEFAULT_SETTINGS, mergeSettings } from "./SettingsRepository";

describe("mergeSettings", () => {
  it("does not ship a default API credential", () => {
    expect(DEFAULT_SETTINGS.provider.apiKey).toBe("");
  });

  it("backfills new provider defaults into legacy persisted settings", () => {
    const legacyProvider = { ...DEFAULT_SETTINGS.provider } as Partial<ProviderConfig>;
    delete legacyProvider.reasoningEffort;

    const merged = mergeSettings(DEFAULT_SETTINGS, {}, legacyProvider as ProviderConfig);

    expect(merged.provider.reasoningEffort).toBe("medium");
  });
});
