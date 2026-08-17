import { useAgentStore } from "../../store/agentStore";

/**
 * Context panel: which tabs are part of the AI workspace, with the ability
 * to add/remove/pin tabs and start a fresh workspace.
 */
export function WorkspacePanel(): JSX.Element {
  const workspace = useAgentStore((s) => s.workspace);
  const newWorkspace = useAgentStore((s) => s.newWorkspace);
  const workspaceAddTab = useAgentStore((s) => s.workspaceAddTab);
  const workspaceAddAllTabs = useAgentStore((s) => s.workspaceAddAllTabs);
  const workspaceRemoveTab = useAgentStore((s) => s.workspaceRemoveTab);
  const workspaceClear = useAgentStore((s) => s.workspaceClear);
  const workspacePinTab = useAgentStore((s) => s.workspacePinTab);
  const activeTabId = useAgentStore((s) => s.activeTabId);

  if (!workspace) {
    return (
      <div className="panel">
        <h2>Context</h2>
        <p className="muted">No workspace yet. Start one to give the agent shared context across tabs.</p>
        <button className="primary-btn" onClick={() => void newWorkspace()}>
          Start workspace
        </button>
      </div>
    );
  }

  const tabs = workspace.tabs;

  return (
    <div className="panel">
      <div className="panel-head">
        <h2>Context</h2>
        <div className="panel-actions">
          <button className="ghost-btn" onClick={() => void newWorkspace()}>New workspace</button>
        </div>
      </div>
      <p className="muted">
        Workspace <strong>{workspace.name}</strong> — {tabs.length} tab{tabs.length === 1 ? "" : "s"} in context
      </p>

      <div className="workspace-actions">
        <button className="ghost-btn" onClick={() => void workspaceAddAllTabs()}>Add all tabs</button>
        <button className="ghost-btn" onClick={() => void workspaceClear()}>Clear context</button>
      </div>

      <ul className="tab-list">
        {tabs.map((t) => (
          <li key={t.tabId} className="tab-entry">
            <div className="tab-entry-main">
              <span className="tab-id">Tab {t.tabId}</span>
              <span className="tab-title">{t.title || t.url}</span>
              {t.pinned && <span className="pin-badge">📌</span>}
              {t.pageChangedSinceInspection && <span className="stale-badge">changed</span>}
              {t.summary && <span className="tab-summary">{t.summary}</span>}
              {t.importantFacts.length > 0 && (
                <ul className="tab-facts">
                  {t.importantFacts.slice(0, 5).map((f) => (
                    <li key={f.id} className={f.stale ? "stale" : ""}>
                      {f.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="tab-entry-actions">
              <button
                className="icon-btn"
                title={t.pinned ? "Unpin" : "Pin to workspace"}
                onClick={() => void workspacePinTab(t.tabId, !t.pinned)}
              >
                📌
              </button>
              <button className="icon-btn" title="Remove from context" onClick={() => void workspaceRemoveTab(t.tabId)}>
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
      {tabs.length === 0 && <p className="muted">No tabs in context. The agent adds tabs it opens or inspects; you can add the current tab manually.</p>}

      <div className="quick-add">
          <button className="ghost-btn" onClick={() => activeTabId !== undefined && void workspaceAddTab(activeTabId)} disabled={activeTabId === undefined}>
          ＋ Add current tab
        </button>
      </div>
    </div>
  );
}
