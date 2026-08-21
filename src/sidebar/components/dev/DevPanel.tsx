import { useEffect, useState } from "react";
import { useAgentStore } from "../../store/agentStore";
import { formatTokens } from "@/shared/tokens";
import type { LLMExchangeLog } from "@/shared/types";

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
  const exchangeLogs = useAgentStore((s) => s.exchangeLogs);
  const refreshExchangeLogs = useAgentStore((s) => s.refreshExchangeLogs);

  useEffect(() => {
    void refresh();
    void refreshExchangeLogs();
  }, [refresh, refreshExchangeLogs]);

  const llmRequests = devEvents.filter((e) => e.kind === "llm_request").slice(-20);
  const toolCalls = devEvents.filter((e) => e.kind === "tool_call").slice(-30);
  const contexts = devEvents.filter((e) => e.kind === "context").slice(-20);

  return (
    <div className="panel dev-panel">
      <div className="panel-head">
        <h2>Developer</h2>
        <button className="ghost-btn" onClick={() => { void refresh(); void refreshExchangeLogs(); }}>Refresh</button>
      </div>

      <section>
        <h3>Environment</h3>
        <p className="mono">Model: {settings?.provider.model ?? "—"}</p>
        <p className="mono">Provider: {settings?.provider.name ?? "—"} ({settings?.provider.protocol ?? "—"})</p>
        {(settings?.provider.endpoints?.length ?? 0) > 0 && (
          <p className="mono">Endpoints: {settings!.provider.endpoints!.length} routed</p>
        )}
        <p className="mono">Status: {runtimeState.status} · iterations: {runtimeState.iterations}</p>
        <p className="mono">Context limit: {settings ? formatTokens(settings.provider.contextLimitTokens) : "—"} tokens</p>
      </section>

      <ExchangeLogsSection logs={exchangeLogs} />

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

/**
 * Full request/response exchange logs with export. Each entry captures the
 * exact messages sent to the provider (including page snapshots embedded in
 * the runtime-context block) and the response returned. Logs are scoped to
 * the current conversation and reset when a new chat is started.
 */
function ExchangeLogsSection({ logs }: { logs: LLMExchangeLog[] }): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const exportJson = (): void => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-exchange-logs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const copyJson = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(logs, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section>
      <div className="exchange-head">
        <h3>Exchange logs ({logs.length})</h3>
        {logs.length > 0 && (
          <div className="exchange-actions">
            <button className="ghost-btn" onClick={copyJson}>{copied ? "✓ Copied" : "Copy JSON"}</button>
            <button className="ghost-btn" onClick={exportJson}>Export JSON</button>
          </div>
        )}
      </div>
      <p className="muted">
        Full request messages (including page snapshots) and provider responses for this chat.
        Logs reset when you start a new chat.
      </p>
      <ul className="exchange-list">
        {logs.map((log) => (
          <li key={log.id} className="exchange-item">
            <button className="exchange-row" onClick={() => toggle(log.id)}>
              <span className="mono">{new Date(log.ts).toLocaleTimeString()}</span>
              <span className="muted">{log.latencyMs}ms</span>
              <span className="mono">{log.model}</span>
              <span>msgs: {log.requestMessages.length}</span>
              <span>tools: {log.requestTools?.length ?? 0}</span>
              <span className="muted">{log.response.finishReason}</span>
              {log.response.toolCalls.length > 0 && <span className="mono">→ {log.response.toolCalls.map((c) => c.name).join(", ")}</span>}
              {log.forceFinal && <span className="badge">final</span>}
              {log.fallbackMode && <span className="badge">fallback</span>}
              <span className="muted">{expanded.has(log.id) ? "▾" : "▸"}</span>
            </button>
            {expanded.has(log.id) && (
              <div className="exchange-detail">
                <div className="exchange-block">
                  <h4>Request messages ({log.requestMessages.length})</h4>
                  {log.requestMessages.map((m, i) => (
                    <div key={i} className="exchange-message">
                      <span className="role-tag">{m.role}</span>
                      <pre className="exchange-pre">{m.content ?? "(no content)"}{m.toolCalls?.length ? `\n[tool calls: ${m.toolCalls.map((c) => c.name).join(", ")}]` : ""}</pre>
                    </div>
                  ))}
                </div>
                {log.requestTools && log.requestTools.length > 0 && (
                  <div className="exchange-block">
                    <h4>Tools advertised ({log.requestTools.length})</h4>
                    <pre className="exchange-pre">{JSON.stringify(log.requestTools.map((t) => t.function.name), null, 2)}</pre>
                  </div>
                )}
                <div className="exchange-block">
                  <h4>Response</h4>
                  <pre className="exchange-pre">{JSON.stringify(log.response, null, 2)}</pre>
                </div>
              </div>
            )}
          </li>
        ))}
        {logs.length === 0 && <li className="muted">No exchanges logged yet. Send a message to capture the first request/response.</li>}
      </ul>
    </section>
  );
}
