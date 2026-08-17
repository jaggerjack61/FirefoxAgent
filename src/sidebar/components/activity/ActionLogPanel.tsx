import { useAgentStore } from "../../store/agentStore";
import { formatClock } from "@/shared/id";

/** Action history: what the agent did, with timestamps. */
export function ActionLogPanel(): JSX.Element {
  const actionLog = useAgentStore((s) => s.actionLog);
  const activity = useAgentStore((s) => s.activity);
  const clearConversation = useAgentStore((s) => s.clearConversation);
  const clearRememberedPages = useAgentStore((s) => s.clearRememberedPages);
  const deleteAllData = useAgentStore((s) => s.deleteAllData);

  const combined = [
    ...activity.map((a) => ({
      id: a.id,
      at: a.startedAt,
      label: a.label,
      status: a.status,
    })),
    ...actionLog.map((l) => ({ id: l.id, at: l.at, label: l.label, status: l.status })),
  ];
  const entries = [...new Map(combined.map((entry) => [entry.id, entry])).values()]
    .sort((a, b) => b.at - a.at);

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Action history</h2>
      </div>
      <p className="muted">Everything the agent did, most recent first.</p>
      <ul className="history-list">
        {entries.slice(0, 100).map((e) => (
          <li key={e.id} className={`history-item ${e.status}`}>
            <span className="history-time">{formatClock(e.at)}</span>
            <span className="history-status">{e.status === "ok" ? "✓" : e.status === "running" ? "→" : "✕"}</span>
            <span className="history-label">{e.label}</span>
          </li>
        ))}
        {entries.length === 0 && <li className="muted">No actions yet.</li>}
      </ul>

      <div className="panel-head" style={{ marginTop: 24 }}>
        <h2>Data</h2>
      </div>
      <div className="data-actions">
        <button className="ghost-btn danger" onClick={() => void clearConversation()}>Clear conversation</button>
        <button className="ghost-btn danger" onClick={() => void clearRememberedPages()}>Clear remembered page data</button>
        <button className="ghost-btn danger" onClick={() => void deleteAllData()}>Delete all local AI data</button>
      </div>
    </div>
  );
}
