import { useState } from "react";
import type { AppSettings } from "@/shared/types";
import { useAgentStore } from "../../store/agentStore";

/** Settings panel: provider, mode, limits, privacy, memory, dev mode. */
export function SettingsPanel(): JSX.Element {
  const settings = useAgentStore((s) => s.settings);
  const saveSettings = useAgentStore((s) => s.saveSettings);
  const hasSiteAccess = useAgentStore((s) => s.hasSiteAccess);
  const ensurePermissions = useAgentStore((s) => s.ensurePermissions);
  const fetchModels = useAgentStore((s) => s.fetchModels);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  if (!settings) return <div className="loading">Loading…</div>;

  const update = (patch: Partial<AppSettings>): void => {
    setSaved(false);
    setTestResult(null);
    void saveSettings({ ...settings, ...patch });
  };

  const updateProvider = (patch: Partial<AppSettings["provider"]>): void => {
    setSaved(false);
    setTestResult(null);
    void saveSettings({ ...settings, provider: { ...settings.provider, ...patch } });
  };

  /** Calls the provider's /models endpoint to verify the connection + key. */
  const testConnection = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const list = await fetchModels();
      setModels(list);
      setTestResult(list.length ? `✓ Connected — ${list.length} model${list.length === 1 ? "" : "s"} available.` : "✓ Connected (endpoint returned no models).");
    } catch (err) {
      setTestResult(null);
      setError(`Connection failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setTesting(false);
    }
  };

  const save = async (): Promise<void> => {
    try {
      await saveSettings(settings);
      setSaved(true);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="panel settings-panel">
      <div className="panel-head">
        <h2>Settings</h2>
        <button className="primary-btn" onClick={() => void save()}>{saved ? "Saved ✓" : "Save"}</button>
      </div>
      {error && <div className="error-banner">{error}</div>}

      <section>
        <h3>AI Provider (OpenAI-compatible)</h3>
        <label>Provider name
          <input value={settings.provider.name} onChange={(e) => updateProvider({ name: e.target.value })} placeholder="e.g. OpenAI, Ollama, LM Studio" />
        </label>
        <label>API base URL
          <input value={settings.provider.baseUrl} onChange={(e) => updateProvider({ baseUrl: e.target.value })} placeholder="https://api.openai.com/v1" />
        </label>
        <label>API key
          <input type="password" value={settings.provider.apiKey} onChange={(e) => updateProvider({ apiKey: e.target.value })} placeholder="sk-…" />
        </label>
        <label>Model
          <input
            value={settings.provider.model}
            onChange={(e) => updateProvider({ model: e.target.value })}
            placeholder="deepseek-chat"
            list="provider-models"
          />
          <datalist id="provider-models">
            {models.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
        </label>
        <div className="access-row">
          <span className="muted">{testing ? "Testing connection…" : (testResult ?? "Verify the base URL and API key.")}</span>
          <button className="ghost-btn" onClick={() => void testConnection()} disabled={testing}>
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>
        <label>Protocol
          <select value={settings.provider.protocol} onChange={(e) => updateProvider({ protocol: e.target.value as "chat_completions" | "responses" })}>
            <option value="chat_completions">chat/completions</option>
            <option value="responses">responses (OpenAI)</option>
          </select>
        </label>
        <label>Temperature
          <input type="number" min={0} max={2} step={0.1} value={settings.provider.temperature}
            onChange={(e) => updateProvider({ temperature: Number(e.target.value) })} />
        </label>
        <label>Max output tokens
          <input type="number" min={1} value={settings.provider.maxOutputTokens}
            onChange={(e) => updateProvider({ maxOutputTokens: Number(e.target.value) })} />
        </label>
        <label>Context limit (tokens)
          <input type="number" min={1000} value={settings.provider.contextLimitTokens}
            onChange={(e) => updateProvider({ contextLimitTokens: Number(e.target.value) })} />
        </label>
        <label>Request timeout (ms)
          <input type="number" min={1000} value={settings.provider.timeoutMs}
            onChange={(e) => updateProvider({ timeoutMs: Number(e.target.value) })} />
        </label>
        <label>Custom headers (JSON, e.g. {"{\"X-Org\": \"acme\"}"})
          <input value={JSON.stringify(settings.provider.customHeaders)} onChange={(e) => {
            try {
              updateProvider({ customHeaders: JSON.parse(e.target.value || "{}") });
            } catch { /* keep last valid */ }
          }} />
        </label>
      </section>

      <section>
        <h3>Behavior</h3>
        <label>Mode
          <select value={settings.mode} onChange={(e) => update({ mode: e.target.value as "interactive" | "agent" })}>
            <option value="agent">Agent — low-risk actions run automatically</option>
            <option value="interactive">Interactive — ask before meaningful actions</option>
          </select>
        </label>
        <label>Max actions per request
          <input type="number" min={1} value={settings.limits.maxActionsPerTask} onChange={(e) => update({ limits: { ...settings.limits, maxActionsPerTask: Number(e.target.value) } })} />
        </label>
        <label>Max tabs inspected
          <input type="number" min={1} value={settings.limits.maxTabsInspected} onChange={(e) => update({ limits: { ...settings.limits, maxTabsInspected: Number(e.target.value) } })} />
        </label>
        <label>Max page text (chars)
          <input type="number" min={500} value={settings.limits.maxPageTextChars} onChange={(e) => update({ limits: { ...settings.limits, maxPageTextChars: Number(e.target.value) } })} />
        </label>
        <label>Task timeout (minutes)
          <input type="number" min={1} value={Math.round(settings.limits.taskTimeoutMs / 60000)} onChange={(e) => update({ limits: { ...settings.limits, taskTimeoutMs: Number(e.target.value) * 60000 } })} />
        </label>
        <label>Search engine
          <select value={settings.searchEngine} onChange={(e) => update({ searchEngine: e.target.value as AppSettings["searchEngine"] })}>
            <option value="google">Google</option>
            <option value="duckduckgo">DuckDuckGo</option>
            <option value="bing">Bing</option>
          </select>
        </label>
      </section>

      <section>
        <h3>Privacy &amp; access</h3>
        <p className="muted">Page content may be sent to the configured AI provider when necessary to perform a request.</p>
        <label className="check">
          <input type="checkbox" checked={settings.privacy.allowActivePageContent}
            onChange={(e) => update({ privacy: { ...settings.privacy, allowActivePageContent: e.target.checked } })} />
          Send active page content
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.privacy.allowOtherTabContent}
            onChange={(e) => update({ privacy: { ...settings.privacy, allowOtherTabContent: e.target.checked } })} />
          Send other-tab content
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.privacy.allowFormValues}
            onChange={(e) => update({ privacy: { ...settings.privacy, allowFormValues: e.target.checked } })} />
          Send form field values
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.privacy.allowSelectedText}
            onChange={(e) => update({ privacy: { ...settings.privacy, allowSelectedText: e.target.checked } })} />
          Send selected text
        </label>
        <p className="muted">Password inputs are always excluded from snapshots.</p>
        <div className="access-row">
          <span>{hasSiteAccess ? "✓ Site access granted" : "Site access not granted"}</span>
          <button className="ghost-btn" onClick={() => void ensurePermissions()}>
            {hasSiteAccess ? "Re-check" : "Grant site access"}
          </button>
        </div>
      </section>

      <section>
        <h3>Context &amp; memory</h3>
        <label className="check">
          <input type="checkbox" checked={settings.compression.enabled}
            onChange={(e) => update({ compression: { ...settings.compression, enabled: e.target.checked } })} />
          Auto-compress long contexts
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.memory.enabled}
            onChange={(e) => update({ memory: { ...settings.memory, enabled: e.target.checked } })} />
          Remember page summaries and facts
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.devMode}
            onChange={(e) => update({ devMode: e.target.checked })} />
          Developer mode (show Dev panel)
        </label>
      </section>

      <section>
        <h3>About</h3>
        <p className="muted">
          BrowserAgent v0.1.0 — browser-native AI agent. The model decides what it wants to do;
          trusted extension code decides what it is allowed to do and performs the action.
        </p>
      </section>
    </div>
  );
}
