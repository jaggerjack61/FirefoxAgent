import { describe, it, expect } from "vitest";
import { TokenBudget } from "./TokenBudget";
import type { AppSettings } from "@/shared/types";
import { DEFAULT_SETTINGS } from "@/settings/SettingsRepository";

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
