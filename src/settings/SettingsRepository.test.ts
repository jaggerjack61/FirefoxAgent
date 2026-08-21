import { describe, expect, it } from "vitest";
import type { ProviderConfig } from "@/shared/types";
import { DEFAULT_SETTINGS, mergeSettings, resolveTokenProfile } from "./SettingsRepository";

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

  it("ships a balanced token-efficiency default", () => {
    expect(DEFAULT_SETTINGS.tokenEfficiency.level).toBe("balanced");
  });

  it("merges tokenEfficiency with defaults for legacy persisted settings", () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {});
    expect(merged.tokenEfficiency.level).toBe("balanced");
    // A partial override keeps the level but still produces a full object.
    const partial = mergeSettings(DEFAULT_SETTINGS, { tokenEfficiency: { level: "aggressive" } });
    expect(partial.tokenEfficiency.level).toBe("aggressive");
  });
});

describe("resolveTokenProfile", () => {
  it("returns the conservative profile with all knobs", () => {
    const p = resolveTokenProfile("conservative");
    expect(p.level).toBe("conservative");
    expect(p.toolOutputHardCap).toBe(30_000);
    expect(p.recentToolOutputCap).toBe(8_000);
    expect(p.summarizeThreshold).toBe(24);
    expect(p.keepRecentMessages).toBe(8);
    expect(p.runtimeContextRetention).toBe("retain");
    expect(p.maxPageTextChars).toBe(6_000);
    expect(p.compactToolJson).toBe(false);
    expect(p.dedupePageReads).toBe(false);
  });

  it("returns the balanced profile (the default)", () => {
    const p = resolveTokenProfile("balanced");
    expect(p.level).toBe("balanced");
    expect(p.toolOutputHardCap).toBe(16_000);
    expect(p.recentToolOutputCap).toBe(4_000);
    expect(p.summarizeThreshold).toBe(16);
    expect(p.keepRecentMessages).toBe(6);
    expect(p.runtimeContextRetention).toBe("compress-previous");
    expect(p.maxPageTextChars).toBe(6_000);
    expect(p.compactToolJson).toBe(true);
    expect(p.dedupePageReads).toBe(true);
  });

  it("returns the aggressive profile with the tightest caps", () => {
    const p = resolveTokenProfile("aggressive");
    expect(p.level).toBe("aggressive");
    expect(p.toolOutputHardCap).toBe(8_000);
    expect(p.recentToolOutputCap).toBe(3_000);
    expect(p.summarizeThreshold).toBe(10);
    expect(p.keepRecentMessages).toBe(4);
    expect(p.runtimeContextRetention).toBe("replace-previous");
    expect(p.maxPageTextChars).toBe(4_000);
    expect(p.compactToolJson).toBe(true);
    expect(p.dedupePageReads).toBe(true);
  });

  it("monotonically tightens caps from conservative → aggressive", () => {
    const c = resolveTokenProfile("conservative");
    const b = resolveTokenProfile("balanced");
    const a = resolveTokenProfile("aggressive");
    expect(a.toolOutputHardCap).toBeLessThan(b.toolOutputHardCap);
    expect(b.toolOutputHardCap).toBeLessThan(c.toolOutputHardCap);
    expect(a.summarizeThreshold).toBeLessThan(b.summarizeThreshold);
    expect(b.summarizeThreshold).toBeLessThan(c.summarizeThreshold);
    expect(a.keepRecentMessages).toBeLessThan(b.keepRecentMessages);
    expect(b.keepRecentMessages).toBeLessThan(c.keepRecentMessages);
  });

  it("resolves 'auto' to aggressive for small-context models (≤16k)", () => {
    const p = resolveTokenProfile("auto", 8_000);
    expect(p.level).toBe("aggressive");
  });

  it("resolves 'auto' to balanced for mid-context models (≤64k)", () => {
    const p = resolveTokenProfile("auto", 64_000);
    expect(p.level).toBe("balanced");
  });

  it("resolves 'auto' to conservative for large-context models (>64k)", () => {
    const p = resolveTokenProfile("auto", 128_000);
    expect(p.level).toBe("conservative");
  });

  it("resolves 'auto' to conservative when context is unknown", () => {
    const p = resolveTokenProfile("auto");
    expect(p.level).toBe("conservative");
  });

  it("resolves 'auto' at the 16k boundary to balanced (not aggressive)", () => {
    // 16_001 is just over the aggressive cutoff → balanced.
    expect(resolveTokenProfile("auto", 16_001).level).toBe("balanced");
    // Exactly 16_000 is the aggressive cutoff (inclusive).
    expect(resolveTokenProfile("auto", 16_000).level).toBe("aggressive");
  });
});
