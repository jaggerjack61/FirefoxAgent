/**
 * Token estimation and budgeting helpers.
 *
 * Estimates are deliberately approximate (chars/4 for latin text, plus a
 * per-message overhead) — enough for budget decisions, never claimed as
 * exact model token counts. A real BPE tokenizer is intentionally avoided
 * to keep the Firefox AMO bundle small.
 */

import type { LLMMessage } from "@/shared/types";

/**
 * Estimate token count for a string. Uses the standard ~4 chars/token
 * approximation for latin text. Code-heavy and non-latin content is denser,
 * so this tends to under-count those; budgeting adds safety margins elsewhere.
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  // ~4 chars per token for latin text; code-heavy content is denser.
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Memoized variant for static content that is re-estimated every turn
 * (system prompt, tool schemas). Backed by a small LRU-bounded cache so
 * repeated calls on the same string are O(1).
 */
const ESTIMATE_CACHE = new Map<string, number>();
const ESTIMATE_CACHE_MAX = 256;

export function estimateTokensMemoized(text: string | null | undefined): number {
  if (!text) return 0;
  const cached = ESTIMATE_CACHE.get(text);
  if (cached !== undefined) return cached;
  const value = estimateTokens(text);
  // LRU eviction: once full, drop the oldest entry before inserting.
  if (ESTIMATE_CACHE.size >= ESTIMATE_CACHE_MAX) {
    const firstKey = ESTIMATE_CACHE.keys().next().value;
    if (firstKey !== undefined) ESTIMATE_CACHE.delete(firstKey);
  }
  ESTIMATE_CACHE.set(text, value);
  return value;
}

/** Per-message overhead added on top of content tokens. */
export const MESSAGE_OVERHEAD_TOKENS = 4;

/**
 * Estimates tokens for a single message, accounting for content, tool calls
 * (serialized), and per-message overhead. Replaces the scattered
 * `estimateTokens(m.content) + 4` pattern across the agent layer.
 */
export function countMessageTokens(message: LLMMessage): number {
  let tokens = estimateTokensMemoized(message.content);
  if (message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      // A tool call is roughly: name + serialized arguments.
      const args = JSON.stringify(call.arguments);
      tokens += estimateTokensMemoized(`${call.name}:${args}`);
    }
  }
  return tokens + MESSAGE_OVERHEAD_TOKENS;
}

/** Sums tokens across a list of messages. */
export function sumMessageTokens(messages: LLMMessage[]): number {
  let total = 0;
  for (const m of messages) total += countMessageTokens(m);
  return total;
}

/**
 * @deprecated Vestigial priority-queue budgeting API, replaced by the tiered
 * `TokenBudget.planCompression`. Kept only for backward compatibility.
 */
export interface TokenBudgetItem {
  label: string;
  tokens: number;
  /** Lower priority items are dropped/compressed first. */
  priority: number;
  kind: "system" | "conversation" | "workspace" | "page" | "tools" | "observations";
}

/** @deprecated Use `TokenBudget` instead. */
export function sumTokens(items: TokenBudgetItem[]): number {
  return items.reduce((acc, i) => acc + i.tokens, 0);
}

/** @deprecated Use `TokenBudget` instead. */
export function sortByPriority(items: TokenBudgetItem[]): TokenBudgetItem[] {
  return [...items].sort((a, b) => a.priority - b.priority);
}

/** Formats a token count for display. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
