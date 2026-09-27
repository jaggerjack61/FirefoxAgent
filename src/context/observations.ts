import type { ConversationStep } from "@/providers/types";
import { estimateTokens, stableStringify } from "@/shared/token";

/** Replace only repeated reads of the same page slice; preserve other queries and pagination. */
export function pruneSupersededReads(steps: ConversationStep[]): void {
  const latest = new Set<string>();
  for (const step of [...steps].reverse()) {
    for (const call of [...step.toolCalls].reverse()) {
      if (call.name !== "read_page") continue;
      const result = step.toolResults.find((entry) => entry.callId === call.id);
      if (!result) continue;
      let output: Record<string, unknown>;
      try {
        output = JSON.parse(result.output) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!Array.isArray(output.blocks) || !Array.isArray(output.elements)) continue;
      const key = stableStringify({
        tabId: call.arguments.tabId,
        frameId: call.arguments.frameId ?? 0,
        query: call.arguments.query ?? "",
        mode: call.arguments.mode ?? "all",
        cursor: call.arguments.cursor ?? null,
        maxTokens: call.arguments.maxTokens ?? 900,
        url: output.url,
      });
      if (latest.has(key))
        result.output = stableStringify({
          status: "superseded",
          url: output.url,
          reason: "Use the newer read of this page slice below.",
        });
      else latest.add(key);
    }
  }
}

/** Outputs at or below this size are cheaper to keep than to replace with a marker. */
const MASKABLE_TOKENS = 40;

function stepTokens(step: ConversationStep): number {
  return (
    estimateTokens(step.text) +
    step.toolCalls.reduce((sum, call) => sum + estimateTokens(stableStringify(call.arguments)), 0) +
    step.toolResults.reduce((sum, result) => sum + estimateTokens(result.output), 0)
  );
}

function elidedMarker(output: string): string {
  let url: unknown;
  try {
    url = (JSON.parse(output) as Record<string, unknown>).url;
  } catch {
    url = undefined;
  }
  return stableStringify({
    status: "elided",
    ...(typeof url === "string" ? { url } : {}),
    reason: "Older result removed to save context. Repeat the call if it is still needed.",
  });
}

/**
 * Keep long runs inside the context budget by eliding old tool outputs once the current-run
 * trace exceeds `highWater`, down to `lowWater`. Masking happens in batches rather than as a
 * sliding window, so the provider prompt prefix stays byte-stable (and cacheable) between
 * masking events. The model's own calls and commentary are kept; the newest `keepRecent`
 * steps are never touched. Returns the number of results elided.
 */
export function maskStaleObservations(
  steps: ConversationStep[],
  highWater: number,
  lowWater: number,
  keepRecent = 2,
): number {
  let total = steps.reduce((sum, step) => sum + stepTokens(step), 0);
  if (total <= highWater) return 0;
  let masked = 0;
  for (const step of steps.slice(0, Math.max(0, steps.length - keepRecent))) {
    for (const result of step.toolResults) {
      if (total <= lowWater) return masked;
      const before = estimateTokens(result.output);
      if (before <= MASKABLE_TOKENS) continue;
      result.output = elidedMarker(result.output);
      total -= before - estimateTokens(result.output);
      masked += 1;
    }
  }
  return masked;
}
