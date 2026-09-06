import { estimateTokens, stableStringify, truncateToTokens } from "@/shared/token";

/** Preserve JSON structure for every tool result, including large tab/frame lists. */
export function serializeToolResult(output: Record<string, unknown>, maxTokens: number): string {
  const full = stableStringify(output);
  if (estimateTokens(full) <= maxTokens) return full;
  for (const key of ["tabs", "frames", "results", "bookmarks"]) {
    if (!Array.isArray(output[key])) continue;
    const entries = [...output[key]];
    const total = entries.length;
    while (entries.length) {
      entries.pop();
      const compact = stableStringify({ ...output, [key]: entries, omitted: total - entries.length });
      if (estimateTokens(compact) <= maxTokens) return compact;
    }
  }
  // A preview is explicitly incomplete, never presented as a complete observation.
  let allowance = Math.max(1, maxTokens - 40);
  while (allowance > 0) {
    const result = stableStringify({ truncated: true, preview: truncateToTokens(full, allowance) });
    if (estimateTokens(result) <= maxTokens) return result;
    allowance -= 10;
  }
  return '{"truncated":true}';
}
