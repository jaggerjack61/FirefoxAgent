/**
 * TokenBudget: estimates the full request size and applies compression
 * tiers when the configured model limit would be exceeded. It never fails
 * a research session just because it grew large.
 */

import type { AppSettings, LLMMessage, TokenProfile } from "@/shared/types";
import { countMessageTokens, estimateTokens, estimateTokensMemoized } from "@/shared/tokens";
import { summarizeConversation } from "./ContextBuilder";

export interface BudgetBreakdown {
  system: number;
  conversation: number;
  workspace: number;
  activeTab: number;
  tools: number;
  total: number;
}

export interface CompressionActions {
  /** Older conversation replaced by a summary. */
  compressConversation: boolean;
  /** Workspace rendering limited to facts only. */
  factsOnlyWorkspace: boolean;
  /** Active tab text dropped (metadata/elements kept). */
  dropActiveTabText: boolean;
  /** Reserved for compatibility; schemas are never dropped because tools become unusable. */
  dropToolDescriptions: boolean;
}

export interface PlanCompressionInput {
  systemPrompt: string;
  conversation: LLMMessage[];
  workspaceText: string;
  activeTabText: string;
  toolDescriptions: string;
}

export class TokenBudget {
  constructor(private readonly settings: AppSettings) {}

  estimate(parts: PlanCompressionInput): { breakdown: BudgetBreakdown; total: number } {
    const breakdown: BudgetBreakdown = {
      system: estimateTokensMemoized(parts.systemPrompt),
      conversation: parts.conversation.reduce((acc, m) => acc + countMessageTokens(m), 0),
      workspace: estimateTokensMemoized(parts.workspaceText),
      activeTab: estimateTokensMemoized(parts.activeTabText),
      tools: estimateTokensMemoized(parts.toolDescriptions),
      total: 0,
    };
    breakdown.total = breakdown.system + breakdown.conversation + breakdown.workspace + breakdown.activeTab + breakdown.tools;
    return { breakdown, total: breakdown.total };
  }

  /**
   * Decides which compression actions bring the request under the limit.
   * Returns the actions; the caller applies them and rebuilds the request.
   *
   * @param profile   Resolved token-efficiency profile (drives thresholds).
   * @param capabilityContextTokens  The model's detected context window, if
   *   known. When supplied, the effective limit is the smaller of this and
   *   `settings.provider.contextLimitTokens` — so a small-context local
   *   model (e.g. llama-3 @ 8k) compresses even when the setting is 64k.
   */
  planCompression(
    parts: PlanCompressionInput,
    profile?: TokenProfile,
    capabilityContextTokens?: number,
  ): CompressionActions {
    if (!this.settings.compression.enabled) {
      return {
        compressConversation: false,
        factsOnlyWorkspace: false,
        dropActiveTabText: false,
        dropToolDescriptions: false,
      };
    }
    const { breakdown } = this.estimate(parts);
    const limit = this.effectiveContextLimit(capabilityContextTokens);
    // Reserve 30% of the window for the response + tool outputs.
    const budget = Math.floor(limit * 0.7);

    const actions: CompressionActions = {
      compressConversation: false,
      factsOnlyWorkspace: false,
      dropActiveTabText: false,
      dropToolDescriptions: false,
    };

    let total = breakdown.total;
    if (total <= budget) return actions;

    // Tier 1: drop active-tab raw text (keep elements).
    if (breakdown.activeTab > 0) {
      actions.dropActiveTabText = true;
      total -= breakdown.activeTab;
    }
    // Tier 2: compress older conversation. The gate scales with the profile:
    // aggressive levels compress sooner (smaller minimum conversation size).
    const conversationGate = profile
      ? Math.min(400, Math.floor(profile.recentToolOutputCap / 10))
      : 400;
    if (total > budget && breakdown.conversation > conversationGate) {
      actions.compressConversation = true;
      total -= breakdown.conversation;
      total += estimateTokens(`[Earlier conversation summary]\n${summarizeConversation(parts.conversation)}`);
    }
    // Tier 3: workspace facts only.
    if (total > budget && breakdown.workspace > 500) {
      actions.factsOnlyWorkspace = true;
      total -= breakdown.workspace;
      total += 300;
    }
    // Tool schemas remain available even under pressure. Omitting them causes
    // invalid tool arguments, which costs more tokens through retries.
    return actions;
  }

  /**
   * The effective context limit is the smaller of the user-configured
   * `contextLimitTokens` and the model's detected capability window. This
   * prevents budgeting against 64k when the real window is 8k (e.g. llama-3).
   */
  private effectiveContextLimit(capabilityContextTokens?: number): number {
    const setting = this.settings.provider.contextLimitTokens || 128_000;
    if (capabilityContextTokens && capabilityContextTokens > 0) {
      return Math.min(setting, capabilityContextTokens);
    }
    return setting;
  }

  /** Human-readable breakdown for the dev view. */
  describe(breakdown: BudgetBreakdown): Record<string, number> {
    return { ...breakdown } as unknown as Record<string, number>;
  }
}
