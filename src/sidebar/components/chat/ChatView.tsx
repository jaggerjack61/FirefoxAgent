import { useEffect, useRef, useState } from "react";
import { useAgentStore } from "../../store/agentStore";
import { MessageItem } from "./MessageItem";
import { ActivityItem } from "./ActivityList";
import { ConfirmationBanner } from "./ConfirmationBanner";
import type { ProviderConfig, ReasoningEffort } from "@/shared/types";

const REASONING_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

export function ChatView(): JSX.Element {
  const messages = useAgentStore((s) => s.messages);
  const activity = useAgentStore((s) => s.activity);
  const streamingText = useAgentStore((s) => s.streamingText);
  const busy = useAgentStore((s) => s.busy);
  const runtimeState = useAgentStore((s) => s.runtimeState);
  const pendingConfirmation = useAgentStore((s) => s.pendingConfirmation);
  const sendMessage = useAgentStore((s) => s.sendMessage);
  const newConversation = useAgentStore((s) => s.newConversation);
  const hasSiteAccess = useAgentStore((s) => s.hasSiteAccess);
  const ensurePermissions = useAgentStore((s) => s.ensurePermissions);
  const settings = useAgentStore((s) => s.settings);
  const saveSettings = useAgentStore((s) => s.saveSettings);
  const fetchModels = useAgentStore((s) => s.fetchModels);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [savingProvider, setSavingProvider] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamingText, activity.length]);

  const submit = async (): Promise<void> => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setError(null);
    try {
      await sendMessage(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const updateProvider = async (patch: Partial<ProviderConfig>): Promise<void> => {
    if (!settings || busy) return;
    setSavingProvider(true);
    setError(null);
    try {
      await saveSettings({ ...settings, provider: { ...settings.provider, ...patch } });
    } catch (err) {
      setError(`Could not update model settings: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSavingProvider(false);
    }
  };

  const loadModels = async (): Promise<void> => {
    if (loadingModels) return;
    setLoadingModels(true);
    setError(null);
    try {
      setModels(await fetchModels());
    } catch (err) {
      setError(`Could not load models: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoadingModels(false);
    }
  };

  const startNewChat = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    try {
      await newConversation();
    } catch (err) {
      setError(`Could not start a new chat: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const suggestedModels = settings?.provider.baseUrl.includes("deepseek.com")
    ? ["deepseek-chat", "deepseek-reasoner"]
    : [];
  const availableModels = [...new Set([settings?.provider.model ?? "", ...suggestedModels, ...models])].filter(Boolean);
  const hasRunningThinking = activity.some((item) => item.kind === "thinking" && item.status === "running");

  const timeline = [
    ...messages
      .filter((message) => message.role !== "tool")
      .map((message) => ({ kind: "message" as const, id: `message:${message.id}`, at: message.createdAt, message })),
    ...activity
      .slice(-24)
      .map((item) => ({ kind: "activity" as const, id: `activity:${item.id}`, at: item.startedAt, activity: item })),
  ].sort((left, right) => left.at - right.at);

  return (
    <div className="chat-view">
      {pendingConfirmation && <ConfirmationBanner request={pendingConfirmation} />}

      {!hasSiteAccess && (
        <div className="access-banner">
          <span>BrowserAgent needs site access to inspect pages.</span>
          <button onClick={() => void ensurePermissions()}>Grant access</button>
        </div>
      )}

      {!settings?.provider.baseUrl && !settings?.provider.apiKey && (
        <div className="access-banner warn">
          <span>Configure an OpenAI-compatible provider in Settings to start.</span>
        </div>
      )}

      {settings && (
        <div className="chat-controls">
          <label>
            <span>Model</span>
            <select
              aria-label="Model"
              value={settings.provider.model}
              disabled={busy || savingProvider}
              onFocus={() => {
                if (models.length === 0) void loadModels();
              }}
              onChange={(event) => void updateProvider({ model: event.target.value })}
            >
              {availableModels.map((model) => (
                <option key={model} value={model}>{model}</option>
              ))}
            </select>
          </label>
          <button
            className="model-refresh"
            type="button"
            title="Refresh models from the provider"
            aria-label="Refresh models"
            disabled={loadingModels || busy}
            onClick={() => void loadModels()}
          >
            {loadingModels ? "…" : "↻"}
          </button>
          <label>
            <span>Reasoning</span>
            <select
              aria-label="Reasoning effort"
              value={settings.provider.reasoningEffort}
              disabled={busy || savingProvider}
              title="Sent to models that support configurable reasoning effort"
              onChange={(event) => void updateProvider({ reasoningEffort: event.target.value as ReasoningEffort })}
            >
              {REASONING_EFFORTS.map((effort) => (
                <option key={effort} value={effort}>{effort}</option>
              ))}
            </select>
          </label>
          <button
            className="new-chat-btn"
            type="button"
            disabled={busy}
            onClick={() => void startNewChat()}
          >
            New chat
          </button>
        </div>
      )}

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && !streamingText && (
          <div className="empty-state">
            <div className="empty-title">Ask anything about your browser</div>
            <ul className="example-prompts">
              <li>“Summarize this page.”</li>
              <li>“Compare the products in these three tabs.”</li>
              <li>“Find the cheapest laptop with 32 GB RAM on this site.”</li>
              <li>“Search for the latest Firefox WebExtension sidebar docs and summarize.”</li>
            </ul>
          </div>
        )}
        {timeline.map((entry) => entry.kind === "message"
          ? <MessageItem key={entry.id} message={entry.message} streaming={false} />
          : <ActivityItem key={entry.id} activity={entry.activity} />)}
        {streamingText && <MessageItem streamingText={streamingText} />}
        {busy && !hasRunningThinking && (
          <div className="agent-thinking" role="status" aria-live="polite">
            <span className="thinking-spinner" aria-hidden="true" />
            <div>
              <strong>Agent thinking</strong>
              <span>{runtimeState.currentActivity ?? "Working…"} · iteration {runtimeState.iterations}</span>
            </div>
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask the agent… (Enter to send)"
          rows={2}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button className="send-btn" disabled={busy || !input.trim()} onClick={() => void submit()}>
          Send
        </button>
      </div>
    </div>
  );
}
