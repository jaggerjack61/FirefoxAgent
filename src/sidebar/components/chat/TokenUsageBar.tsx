import type { TokenUsageMetrics } from "@/shared/types";
import { formatTokens } from "@/shared/tokens";

export function TokenUsageBar({ usage }: { usage: TokenUsageMetrics }): JSX.Element {
  const cacheDenominator = usage.cachedInputTokens + usage.cacheMissTokens;
  const cacheAvailable = usage.cacheReportingRequests > 0;
  const cachePercent = cacheAvailable && cacheDenominator > 0
    ? Math.round((usage.cachedInputTokens / cacheDenominator) * 100)
    : cacheAvailable ? 0 : null;
  const contextPercent = usage.contextLimitTokens > 0
    ? Math.round((usage.lastContextTokens / usage.contextLimitTokens) * 100)
    : 0;
  const estimateMark = usage.estimatedRequests > 0 ? "~" : "";

  return (
    <div
      className="token-usage-bar"
      data-testid="token-usage-bar"
      aria-label={`Token usage: ${cachePercent === null ? "cache unavailable" : `${cachePercent}% cache hit`}, ${usage.inputTokens} uploaded, ${usage.outputTokens} received, ${contextPercent}% context used`}
    >
      <div className="usage-stat usage-cache" title="Provider prompt-cache totals for this conversation">
        <span className="usage-main"><small>Cache</small><strong>{cachePercent === null ? "—" : `${cachePercent}%`}</strong></span>
        <span className="usage-detail">
          <i className="usage-hit">H {cacheAvailable ? formatTokens(usage.cachedInputTokens) : "—"}</i>
          <i className="usage-miss">M {cacheAvailable ? formatTokens(usage.cacheMissTokens) : "—"}</i>
          <i className="usage-write">W {cacheAvailable ? formatTokens(usage.cacheWriteTokens) : "—"}</i>
        </span>
      </div>
      <div className="usage-stat usage-upload" title="Input tokens uploaded across provider requests">
        <span className="usage-main"><small>Uploaded</small><strong>↑ {estimateMark}{formatTokens(usage.inputTokens)}</strong></span>
      </div>
      <div className="usage-stat usage-received" title="Output tokens received across provider responses">
        <span className="usage-main"><small>Received</small><strong>↓ {estimateMark}{formatTokens(usage.outputTokens)}</strong></span>
      </div>
      <div className="usage-stat usage-context" title={`${formatTokens(usage.lastContextTokens)} of ${formatTokens(usage.contextLimitTokens)} tokens used by the latest request`}>
        <span className="usage-main"><small>Context</small><strong>{contextPercent}%</strong></span>
        <span className="usage-context-track" aria-hidden="true">
          <span style={{ width: `${Math.min(100, Math.max(0, contextPercent))}%` }} />
        </span>
      </div>
    </div>
  );
}
