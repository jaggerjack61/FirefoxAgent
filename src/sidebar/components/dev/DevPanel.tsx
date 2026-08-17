import { useEffect } from "react";
import { useAgentStore } from "../../store/agentStore";
import { formatTokens } from "@/shared/tokens";

/**
 * Developer view: LLM requests, tool calls, context sizes, token estimates.
 * All sensitive values (API keys) are redacted in the background before
 * they reach this view.
 */
export function DevPanel(): JSX.Element {
  const devEvents = useAgentStore((s) => s.devEvents);
  const refresh = useAgentStore((s) => s.refreshDevEvents);
  const settings = useAgentStore((s) => s.settings);
  const runtimeState = useAgentStore((s) => s.runtimeState);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const llmRequests = devEvents.filter((e) => e.kind === "llm_request").slice(-20);
  const toolCalls = devEvents.filter((e) => e.kind === "tool_call").slice(-30);
  const contexts = devEvents.filter((e) => e.kind === "context").slice(-20);

  return (
    <div className="panel dev-panel">
      <div className="panel-head">
        <h2>Developer</h2>
        <button className="ghost-btn" onClick={() => void refresh()}>Refresh</button>
      </div>

      <section>
        <h3>Environment</h3>
        <p className="mono">Model: {settings?.provider.model ?? "—"}</p>
        <p className="mono">Provider: {settings?.provider.name ?? "—"} ({settings?.provider.protocol ?? "—"})</p>
        <p className="mono">Status: {runtimeState.status} · iterations: {runtimeState.iterations}</p>
        <p className="mono">Context limit: {settings ? formatTokens(settings.provider.contextLimitTokens) : "—"} tokens</p>
      </section>

      <section>
        <h3>Context size (last requests)</h3>
        <table className="dev-table">
          <thead>
            <tr><th>time</th><th>system</th><th>conv</th><th>ws</th><th>tab</th><th>tools</th><th>total</th><th>compressed</th></tr>
          </thead>
          <tbody>
            {contexts.map((c, i) => (
              <tr key={i}>
                <td>{new Date(c.ts).toLocaleTimeString()}</td>
                <td>{formatTokens(c.layers.system ?? 0)}</td>
                <td>{formatTokens(c.layers.conversation ?? 0)}</td>
                <td>{formatTokens(c.layers.workspace ?? 0)}</td>
                <td>{formatTokens(c.layers.activeTab ?? 0)}</td>
                <td>{formatTokens(c.layers.tools ?? 0)}</td>
                <td><strong>{formatTokens(c.totalTokens)}</strong></td>
                <td>{c.compressed ? "yes" : "no"}</td>
              </tr>
            ))}
            {contexts.length === 0 && <tr><td colSpan={8} className="muted">No requests yet.</td></tr>}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Tool calls</h3>
        <ul className="dev-list">
          {toolCalls.map((t, i) => (
            <li key={i} className={t.ok ? "ok" : "err"}>
              <span className="mono">{t.ok ? "✓" : "✕"} {t.tool}</span>
              <span className="muted">{t.latencyMs}ms</span>
              {!t.ok && <span className="muted"> — failed</span>}
            </li>
          ))}
          {toolCalls.length === 0 && <li className="muted">No tool calls yet.</li>}
        </ul>
      </section>

      <section>
        <h3>LLM requests</h3>
        <ul className="dev-list">
          {llmRequests.map((r, i) => (
            <li key={i}>
              <span className="mono">{new Date(r.ts).toLocaleTimeString()}</span>
              <span> messages: {r.messageCount}</span>
              <span> tokens: {formatTokens(r.estimatedTokens)}</span>
            </li>
          ))}
          {llmRequests.length === 0 && <li className="muted">No requests yet.</li>}
        </ul>
      </section>
    </div>
  );
}
