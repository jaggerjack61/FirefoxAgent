import type { ConversationStep } from "@/providers/types";
import { stableStringify } from "@/shared/token";

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
