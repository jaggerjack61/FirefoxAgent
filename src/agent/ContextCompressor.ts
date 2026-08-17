/**
 * ContextCompressor: automatic compression of conversation + workspace
 * context when limits are hit. Pure functions, unit-testable.
 *
 * Compression strategy (spec §8):
 *  1. keep recent messages verbatim
 *  2. summarize older conversation
 *  3. summarize inspected pages
 *  4. preserve important facts separately
 *  5. preserve unresolved goals/tasks
 *  6. discard low-value raw observations
 */

import type { Fact, LLMMessage, WorkspaceTab } from "@/shared/types";

export interface CompressibleConversation {
  messages: LLMMessage[];
  keepRecent: number;
}

export interface CompressedConversation {
  messages: LLMMessage[];
  /** Summary of the dropped prefix. */
  summary: string;
  droppedCount: number;
}

/**
 * Compresses a conversation: keeps the N most recent messages verbatim and
 * summarizes the rest into a single synthetic message. Tool observations
 * are the first to be discarded from the summary (lowest value).
 */
export function compressConversation(input: CompressibleConversation): CompressedConversation {
  const { messages, keepRecent } = input;
  if (messages.length <= keepRecent + 1) {
    return { messages, summary: "", droppedCount: 0 };
  }
  const recent = messages.slice(-keepRecent);
  const older = messages.slice(0, messages.length - keepRecent);

  // Keep only user/assistant intents from the older block; drop raw
  // observations (tool outputs) — they are the largest and least reusable.
  const distilled = older.filter((m) => m.role !== "tool");
  const summary = summarizeMessages(distilled, older.filter((m) => m.role === "tool").length);

  return {
    messages: [
      {
        role: "user",
        content: `[Earlier conversation, summarized]\n${summary}\n\nContinue from here. Recent messages follow.`,
      },
      ...recent,
    ],
    summary,
    droppedCount: older.length - distilled.length,
  };
}

function summarizeMessages(messages: LLMMessage[], droppedObservations: number): string {
  const lines: string[] = [];
  for (const m of messages) {
    const content = (m.content ?? "").replace(/\s+/g, " ").slice(0, 200);
    if (m.role === "user") lines.push(`User asked: ${content}`);
    else if (m.role === "assistant") {
      const tools = m.toolCalls?.map((t) => t.name).join(", ");
      lines.push(`Agent: ${content.slice(0, 100)}${tools ? ` (called: ${tools})` : ""}`);
    } else if (m.role === "system") {
      lines.push(`System: ${content.slice(0, 80)}`);
    }
  }
  if (droppedObservations > 0) lines.push(`(${droppedObservations} raw tool observations omitted)`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Workspace compression
// ---------------------------------------------------------------------------

export interface CompressibleWorkspace {
  tabs: WorkspaceTab[];
  /** Always keep facts with these categories. */
  keepCategories?: string[];
}

export interface CompressedWorkspace {
  /** Tabs rendered as summaries + facts only. */
  tabs: WorkspaceTab[];
  droppedRaw: number;
}

/**
 * Compresses workspace tab state: summaries stay, per-tab facts stay,
 * everything else (entities, raw notes) is dropped. Facts marked stale are
 * demoted to the end.
 */
export function compressWorkspace(input: CompressibleWorkspace): CompressedWorkspace {
  const keepCategories = new Set(input.keepCategories ?? ["price", "spec", "contact"]);
  const tabs = input.tabs.map((t) => ({
    ...t,
    importantFacts: [...t.importantFacts]
      .sort((a, b) => Number(a.stale ?? false) - Number(b.stale ?? false))
      .filter((f) => keepCategories.has(f.category ?? "") || !f.stale)
      .slice(0, 12),
    extractedEntities: [],
  }));
  return { tabs, droppedRaw: 0 };
}

// ---------------------------------------------------------------------------
// Task/goal preservation
// ---------------------------------------------------------------------------

/** Extracts the still-relevant goal + facts from a task for re-injection. */
export function preserveTaskEssence(goal: string, facts: Fact[], completedSteps: string[]): string {
  return [
    `TASK: ${goal}`,
    "COMPLETED:",
    ...completedSteps.slice(-8).map((s) => `- ${s}`),
    "IMPORTANT FACTS:",
    ...facts.slice(-15).map((f) => `- ${f.text}`),
  ].join("\n");
}
