import { useEffect } from "react";
import { useAgentStore } from "../store/agentStore";
import { getRuntime } from "../lib/runtime";
import { ChatView } from "./chat/ChatView";
import { WorkspacePanel } from "./context/WorkspacePanel";
import { ActionLogPanel } from "./activity/ActionLogPanel";
import { SettingsPanel } from "./settings/SettingsPanel";
import { DevPanel } from "./dev/DevPanel";

export function App(): JSX.Element {
  const view = useAgentStore((s) => s.view);
  const setView = useAgentStore((s) => s.setView);
  const bootstrap = useAgentStore((s) => s.bootstrap);
  const bootstrapped = useAgentStore((s) => s.bootstrapped);
  const devMode = useAgentStore((s) => s.settings?.devMode ?? false);
  const busy = useAgentStore((s) => s.busy);
  const stop = useAgentStore((s) => s.stop);

  useEffect(() => {
    void bootstrap();
    const unsubscribe = getRuntime().onEvent((event) => useAgentStore.getState().applyEvent(event));
    return unsubscribe;
  }, [bootstrap]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <span className="logo">✦</span>
          <span>Firefox Agent</span>
          {busy && <span className="pulse-dot" title="Agent running" />}
        </div>
        <nav className="view-tabs">
          <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>Chat</button>
          <button className={view === "context" ? "active" : ""} onClick={() => setView("context")}>Context</button>
          <button className={view === "activity" ? "active" : ""} onClick={() => setView("activity")}>History</button>
          <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>Settings</button>
          {devMode && <button className={view === "dev" ? "active" : ""} onClick={() => setView("dev")}>Dev</button>}
        </nav>
        {busy && (
          <button className="stop-btn" onClick={() => stop()}>
            ■ Stop
          </button>
        )}
      </header>

      {!bootstrapped ? (
        <div className="loading">Loading…</div>
      ) : (
        <main className="app-main">
          {view === "chat" && <ChatView />}
          {view === "context" && <WorkspacePanel />}
          {view === "activity" && <ActionLogPanel />}
          {view === "settings" && <SettingsPanel />}
          {view === "dev" && <DevPanel />}
        </main>
      )}
    </div>
  );
}
