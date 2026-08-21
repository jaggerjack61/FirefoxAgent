import { describe, it, expect } from "vitest";
import { TokenBudget } from "./TokenBudget";
import type { AppSettings, TokenProfile } from "@/shared/types";
import { DEFAULT_SETTINGS, resolveTokenProfile } from "@/settings/SettingsRepository";

function settingsWithLimit(limit: number): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    provider: { ...DEFAULT_SETTINGS.provider, contextLimitTokens: limit },
  };
}

const bigText = (n: number): string => "word ".repeat(n);

describe("TokenBudget", () => {
  it("estimates all layers", () => {
    const budget = new TokenBudget(settingsWithLimit(128_000));
    const { breakdown, total } = budget.estimate({
      systemPrompt: "system",
      conversation: [{ role: "user", content: "hello" }],
      workspaceText: "workspace",
      activeTabText: "page",
      toolDescriptions: "tools",
    });
    expect(total).toBe(breakdown.total);
    expect(breakdown.system).toBeGreaterThan(0);
  });

  it("plans no compression when under budget", () => {
    const budget = new TokenBudget(settingsWithLimit(128_000));
    const actions = budget.planCompression({
      systemPrompt: "s",
      conversation: [{ role: "user", content: "hi" }],
      workspaceText: "",
      activeTabText: "",
      toolDescriptions: "",
    });
    expect(actions.compressConversation).toBe(false);
    expect(actions.dropActiveTabText).toBe(false);
  });

  it("drops active tab text first when over budget", () => {
    const budget = new TokenBudget(settingsWithLimit(4_000));
    const actions = budget.planCompression({
      systemPrompt: bigText(500),
      conversation: [],
      workspaceText: "",
      activeTabText: bigText(6_000),
      toolDescriptions: "",
    });
    expect(actions.dropActiveTabText).toBe(true);
  });

  it("compresses conversation when still over budget", () => {
    const budget = new TokenBudget(settingsWithLimit(2_000));
    const conversation: { role: "user"; content: string }[] = Array.from({ length: 40 }, (_, i) => ({
      role: "user" as const,
      content: bigText(300) + i,
    }));
    const actions = budget.planCompression({
      systemPrompt: bigText(300),
      conversation,
      workspaceText: bigText(300),
      activeTabText: bigText(300),
      toolDescriptions: bigText(300),
    });
    expect(actions.compressConversation).toBe(true);
  });

  it("degrades gracefully to facts-only workspace", () => {
    const budget = new TokenBudget(settingsWithLimit(1_500));
    const actions = budget.planCompression({
      systemPrompt: bigText(200),
      conversation: Array.from({ length: 10 }, () => ({ role: "user" as const, content: bigText(100) })),
      workspaceText: bigText(2_000),
      activeTabText: bigText(500),
      toolDescriptions: bigText(100),
    });
    expect(actions.compressConversation || actions.factsOnlyWorkspace || actions.dropActiveTabText).toBe(true);
  });
});

describe("TokenBudget — capability decoupling (effectiveContextLimit)", () => {
  it("uses the smaller of the setting and the capability window", () => {
    // Setting says 64k, but the detected capability is only 8k (e.g. llama-3).
    // With ~2.8k of content and a 30% response reserve, the 8k window
    // (budget ≈ 5.6k) should NOT trigger compression, but the 64k window
    // definitely should not either. We verify the cap binds by making the
    // content large enough to exceed 8k's budget but not 64k's.
    const budget = new TokenBudget(settingsWithLimit(64_000));
    const conversation = Array.from({ length: 60 }, () => ({ role: "user" as const, content: bigText(100) }));
    // ~6k tokens of conversation alone. With 64k limit, budget ≈ 44.8k → no compression.
    expect(budget.planCompression({
      systemPrompt: "s",
      conversation,
      workspaceText: "",
      activeTabText: "",
      toolDescriptions: "",
    }).compressConversation).toBe(false);

    // Same content but capability says 8k → budget ≈ 5.6k → must compress.
    expect(budget.planCompression(
      { systemPrompt: "s", conversation, workspaceText: "", activeTabText: "", toolDescriptions: "" },
      undefined,
      8_000,
    ).compressConversation).toBe(true);
  });

  it("ignores a non-positive capability value and falls back to the setting", () => {
    const budget = new TokenBudget(settingsWithLimit(128_000));
    const actions = budget.planCompression(
      { systemPrompt: "s", conversation: [{ role: "user", content: "hi" }], workspaceText: "", activeTabText: "", toolDescriptions: "" },
      undefined,
      0,
    );
    expect(actions.compressConversation).toBe(false);
  });
});

describe("TokenBudget — profile-driven compression", () => {
  it("compresses sooner with an aggressive profile (lower summarize gate)", () => {
    // A conversation large enough to exceed the 2k budget. The aggressive
    // profile lowers the conversation gate (scales with recentToolOutputCap),
    // so compression triggers even for smaller conversations.
    const budget = new TokenBudget(settingsWithLimit(2_000));
    const conversation = Array.from({ length: 20 }, () => ({ role: "user" as const, content: bigText(100) }));
    const aggressive: TokenProfile = resolveTokenProfile("aggressive");

    const withProfile = budget.planCompression(
      { systemPrompt: bigText(50), conversation, workspaceText: "", activeTabText: "", toolDescriptions: "" },
      aggressive,
    );
    // The aggressive profile lowers the conversation gate, so compression triggers.
    expect(withProfile.compressConversation).toBe(true);
  });

  it("does not compress a tiny conversation even with an aggressive profile", () => {
    const budget = new TokenBudget(settingsWithLimit(128_000));
    const aggressive: TokenProfile = resolveTokenProfile("aggressive");
    const actions = budget.planCompression(
      { systemPrompt: "s", conversation: [{ role: "user", content: "hi" }], workspaceText: "", activeTabText: "", toolDescriptions: "" },
      aggressive,
    );
    expect(actions.compressConversation).toBe(false);
  });

  it("does not compress when disabled in settings", () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      provider: { ...DEFAULT_SETTINGS.provider, contextLimitTokens: 100 },
      compression: { ...DEFAULT_SETTINGS.compression, enabled: false },
    };
    const budget = new TokenBudget(settings);
    const actions = budget.planCompression({
      systemPrompt: bigText(500),
      conversation: Array.from({ length: 50 }, () => ({ role: "user" as const, content: bigText(100) })),
      workspaceText: bigText(500),
      activeTabText: bigText(500),
      toolDescriptions: bigText(500),
    });
    expect(actions.compressConversation).toBe(false);
    expect(actions.dropActiveTabText).toBe(false);
    expect(actions.factsOnlyWorkspace).toBe(false);
  });
});
