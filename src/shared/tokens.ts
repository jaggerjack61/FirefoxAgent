/**
 * Token estimation and budgeting helpers.
 *
 * Estimates are deliberately approximate (chars/4 for latin text, plus a
 * per-message overhead) — enough for budget decisions, never claimed as
 * exact model token counts.
 */

export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // ~4 chars per token for latin text; code-heavy content is denser.
  const chars = text.length;
  const words = text.split(/\s+/).length;
  return Math.max(1, Math.ceil(chars / 4) + Math.ceil(words / 12));
}

export const MESSAGE_OVERHEAD_TOKENS = 4;

export interface TokenBudgetItem {
  label: string;
  tokens: number;
  /** Lower priority items are dropped/compressed first. */
  priority: number;
  kind: "system" | "conversation" | "workspace" | "page" | "tools" | "observations";
}

export function sumTokens(items: TokenBudgetItem[]): number {
  return items.reduce((acc, i) => acc + i.tokens, 0);
}

export function sortByPriority(items: TokenBudgetItem[]): TokenBudgetItem[] {
  return [...items].sort((a, b) => a.priority - b.priority);
}

/** Formats a token count for display. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
