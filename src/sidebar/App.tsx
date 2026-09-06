import { Fragment, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_SETTINGS,
  appSnapshotSchema,
  providerConnectionSchema,
  providerSettingsSchema,
  type AgentEvent,
  type AppSettings,
  type AppSnapshot,
  type ProviderSettings,
  type SafetyMode,
  type WorkspaceNote,
} from "@/shared/schema";
import { selectProvider, updateActiveProvider } from "@/settings/profiles";
import { createId, estimateTokens, TOKEN_LIMITS } from "@/shared/token";
import { CORE_INSTRUCTIONS } from "@/context/compiler";
import { TOOL_DEFINITION_TOKENS } from "@/tools/definitions";
import { providerOriginPattern } from "@/providers/http";
import { backgroundClient } from "./runtime";
import { groupThinking, type ThinkingGroup } from "./thinking";

type View = "chat" | "memory" | "usage" | "settings";

interface ActiveStream {
  runId: string;
  turn: number;
  text: string;
}

const EMPTY_CAPABILITIES: ProviderSettings["capabilities"] = {
  exactCounting: false,
  explicitCaching: false,
  nativeCompaction: false,
  streamingUsage: false,
};

const EMPTY_PROVIDER: ProviderSettings = {
  protocol: "responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "",
  availableModels: [],
  contextWindow: 32_000,
  maxOutputTokens: 2_048,
  maxThinkingTurns: TOKEN_LIMITS.maxTurns,
  capabilities: EMPTY_CAPABILITIES,
};

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [view, setView] = useState<View>("chat");
  const [draft, setDraft] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [input, setInput] = useState("");
  const [stream, setStream] = useState<ActiveStream | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [chatModel, setChatModel] = useState("");
  const messageEnd = useRef<HTMLDivElement>(null);

  const refresh = async () => {
    try {
      const raw = await backgroundClient.send<unknown>({ type: "get_state" });
      const state = appSnapshotSchema.parse(raw);
      setSnapshot(state);
      setDraft(state.settings);
      setError("");
    } catch (reason) {
      setError(message(reason));
    }
  };

  useEffect(() => {
    void refresh();
    return backgroundClient.subscribe((event) =>
      handleEvent(event, setSnapshot, setStream, setNotice, setError),
    );
  }, []);

  useEffect(() => {
    messageEnd.current?.scrollIntoView({ block: "end" });
  }, [snapshot?.messages, snapshot?.modelTurns, stream?.text]);

  const active = Boolean(snapshot?.activeRun);
  const provider = draft.provider ?? EMPTY_PROVIDER;
  const savedModel = snapshot?.settings.provider?.model ?? "";
  const chatModelOptions = useMemo(() => {
    const models = snapshot?.settings.provider?.availableModels ?? [];
    return savedModel && !models.includes(savedModel) ? [savedModel, ...models] : models;
  }, [snapshot?.settings.provider?.availableModels, savedModel]);

  useEffect(() => {
    setChatModel(savedModel);
  }, [savedModel]);

  const usageTotals = useMemo(() => {
    return (snapshot?.usage ?? []).reduce(
      (total, item) => ({
        input: total.input + item.input,
        cached: total.cached + item.cachedInput,
        output: total.output + item.output,
        total: total.total + item.total,
      }),
      { input: 0, cached: 0, output: 0, total: 0 },
    );
  }, [snapshot?.usage]);

  const sendMessage = async () => {
    const text = input.trim();
    if (!text || active) return;
    setInput("");
    setStream(null);
    setError("");
    try {
      const configuredProvider = snapshot?.settings.provider;
      if (configuredProvider) await requestProviderAccess(configuredProvider.baseUrl);
      await backgroundClient.send({ type: "send_message", text });
    } catch (reason) {
      setError(message(reason));
      setInput(text);
    }
  };

  const setMode = async (mode: SafetyMode) => {
    if (mode === "yolo") {
      const accepted = window.confirm(
        "YOLO mode executes valid browser actions without confirmation, including financial and destructive actions. It lasts only for this browser session. Enable it?",
      );
      if (!accepted) return;
    }
    try {
      await backgroundClient.send({ type: "set_mode", mode });
      if (mode !== "yolo") setDraft((current) => ({ ...current, mode }));
    } catch (reason) {
      setError(message(reason));
    }
  };

  const saveSettings = async () => {
    setBusy(true);
    try {
      const settings =
        draft.provider || draft.providers.length
          ? updateActiveProvider(draft, providerSettingsSchema.parse(provider))
          : draft;
      await backgroundClient.send({ type: "save_settings", settings });
      setNotice("Settings saved");
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const editProfile = (id: string) => {
    try {
      const committed = draft.provider
        ? updateActiveProvider(draft, providerSettingsSchema.parse(provider))
        : draft;
      setDraft(selectProvider(committed, id));
      setError("");
    } catch (reason) {
      setError(message(reason));
    }
  };

  const addProfile = () => {
    try {
      const committed = draft.provider
        ? updateActiveProvider(draft, providerSettingsSchema.parse(provider))
        : draft;
      const id = createId("provider");
      const settings = { ...EMPTY_PROVIDER, protocol: "chat_completions" as const };
      setDraft({
        ...committed,
        activeProviderId: id,
        provider: settings,
        providers: [
          ...committed.providers,
          { id, name: `Provider ${committed.providers.length + 1}`, settings },
        ],
      });
      setError("");
    } catch (reason) {
      setError(message(reason));
    }
  };

  const removeProfile = () => {
    if (!window.confirm("Remove this provider profile and its saved API key? Save to apply.")) return;
    const providers = draft.providers.filter((profile) => profile.id !== draft.activeProviderId);
    setDraft({
      ...draft,
      providers,
      activeProviderId: providers[0]?.id ?? null,
      provider: providers[0]?.settings ?? null,
    });
  };

  const switchProvider = async (providerId: string) => {
    setBusy(true);
    setError("");
    try {
      await backgroundClient.send({ type: "set_provider", providerId });
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const testProvider = async () => {
    setBusy(true);
    setNotice("Testing provider…");
    setError("");
    try {
      const candidate = providerSettingsSchema.parse(provider);
      await requestProviderAccess(candidate.baseUrl);
      const result = await backgroundClient.send<{
        capabilities: ProviderSettings["capabilities"];
        message: string;
      }>({
        type: "test_provider",
        provider: candidate,
      });
      setDraft((current) => ({
        ...current,
        provider: { ...(current.provider ?? provider), capabilities: result.capabilities },
      }));
      setNotice(`Connected: ${result.message}`);
    } catch (reason) {
      setError(message(reason));
      setNotice("");
    } finally {
      setBusy(false);
    }
  };

  const loadModels = async () => {
    setBusy(true);
    setNotice("Loading models…");
    setError("");
    try {
      const connection = providerConnectionSchema.parse({
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey,
      });
      await requestProviderAccess(connection.baseUrl);
      const result = await backgroundClient.send<{ models: string[] }>({
        type: "list_provider_models",
        provider: connection,
      });
      setDraft((current) => {
        const currentProvider = current.provider ?? provider;
        return {
          ...current,
          provider: {
            ...currentProvider,
            model: currentProvider.model || result.models[0] || "",
            availableModels: result.models,
          },
        };
      });
      setNotice(
        result.models.length > 0
          ? `Loaded ${result.models.length.toLocaleString()} models`
          : "Connected, but the endpoint returned no models; enter a model ID manually.",
      );
    } catch (reason) {
      setError(message(reason));
      setNotice("");
    } finally {
      setBusy(false);
    }
  };

  const applyModelChange = async (model: string, availableModels?: string[]) => {
    try {
      await backgroundClient.send({
        type: "set_model",
        model,
        ...(availableModels ? { availableModels } : {}),
      });
    } catch (reason) {
      setError(message(reason));
      return false;
    }
    setDraft((current) =>
      current.provider
        ? {
            ...current,
            ...updateActiveProvider(current, {
              ...current.provider,
              model,
              availableModels: availableModels ?? current.provider.availableModels,
              capabilities:
                model === current.provider.model ? current.provider.capabilities : EMPTY_CAPABILITIES,
            }),
          }
        : current,
    );
    return true;
  };

  const commitModel = async (model: string) => {
    if (!model || model === savedModel) return;
    const applied = await applyModelChange(model);
    if (!applied) setChatModel(savedModel);
  };

  const loadChatModels = async () => {
    const configured = snapshot?.settings.provider;
    if (!configured) return;
    setBusy(true);
    setNotice("Loading models…");
    setError("");
    try {
      const connection = providerConnectionSchema.parse({
        baseUrl: configured.baseUrl,
        apiKey: configured.apiKey,
      });
      await requestProviderAccess(connection.baseUrl);
      const result = await backgroundClient.send<{ models: string[] }>({
        type: "list_provider_models",
        provider: connection,
      });
      const applied = await applyModelChange(configured.model, result.models);
      if (!applied) {
        setNotice("");
        return;
      }
      setNotice(
        result.models.length > 0
          ? `Loaded ${result.models.length.toLocaleString()} models`
          : "Connected, but the endpoint returned no models; set a model ID in settings.",
      );
    } catch (reason) {
      setError(message(reason));
      setNotice("");
    } finally {
      setBusy(false);
    }
  };

  const startNewChat = async () => {
    if (active || busy) return;
    const accepted = window.confirm(
      "Start a new chat? This permanently clears the current chat and its workspace memory.",
    );
    if (!accepted) return;
    setBusy(true);
    setError("");
    try {
      await backgroundClient.send({ type: "new_chat" });
      setInput("");
      setStream(null);
      setView("chat");
      setNotice("New chat started");
      await refresh();
    } catch (reason) {
      setError(message(reason));
    } finally {
      setBusy(false);
    }
  };

  const grantSiteAccess = async () => {
    setError("");
    try {
      const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
      if (!granted) throw new Error("Firefox website access was not granted");
      await backgroundClient.send({ type: "request_site_access" });
      setNotice("Website access granted");
      await refresh();
    } catch (reason) {
      setError(message(reason));
    }
  };

  if (!snapshot) {
    return <main className="loading">{error || "Connecting to BrowserAgent…"}</main>;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="identity">
          <strong>BrowserAgent</strong>
          <span className={active ? "status running" : "status"}>
            {active ? snapshot.activeRun?.status : "ready"}
          </span>
        </div>
        <div className="topbar-actions">
          <button className="new-chat" disabled={active || busy} onClick={() => void startNewChat()}>
            New chat
          </button>
          <select
            aria-label="Safety mode"
            className={snapshot.mode === "yolo" ? "mode-yolo" : ""}
            value={snapshot.mode}
            disabled={active}
            onChange={(event) => void setMode(event.target.value as SafetyMode)}
          >
            <option value="interactive">Interactive</option>
            <option value="agent">Agent</option>
            <option value="yolo">YOLO</option>
          </select>
        </div>
      </header>

      {snapshot.mode === "yolo" && (
        <div className="yolo-warning">YOLO is active: actions run without confirmation.</div>
      )}

      <nav className="tabs" aria-label="Sidebar sections">
        {(["chat", "memory", "usage", "settings"] as const).map((entry) => (
          <button key={entry} className={view === entry ? "active" : ""} onClick={() => setView(entry)}>
            {entry}
          </button>
        ))}
      </nav>

      {(notice || error) && (
        <div
          className={error ? "banner error" : "banner"}
          onClick={() => {
            setNotice("");
            setError("");
          }}
        >
          {error || notice}
        </div>
      )}

      <main className="content">
        {view === "chat" && (
          <section className="chat">
            {!snapshot.settings.provider && (
              <EmptyCard
                title="Connect a model provider"
                text="BrowserAgent sends requests directly from Firefox using your own endpoint and key."
                action="Open settings"
                onAction={() => setView("settings")}
              />
            )}
            {!snapshot.hasSiteAccess && (
              <EmptyCard
                title="Allow website access"
                text="Page tools need one Firefox permission covering all HTTP(S) sites."
                action="Grant access"
                onAction={() => void grantSiteAccess()}
              />
            )}
            <div className="messages">
              {snapshot.messages.length === 0 && (
                <p className="muted intro">Ask about the active page, compare tabs, or complete a form.</p>
              )}
              {snapshot.messages.map((entry) => {
                const turns = snapshot.modelTurns.filter((turn) => turn.runId === entry.runId);
                const groups =
                  entry.role === "user"
                    ? groupThinking(turns, stream?.runId === entry.runId ? stream : null)
                    : [];
                return (
                  <Fragment key={entry.id}>
                    <article className={`message ${entry.role}`}>
                      <small>{entry.role}</small>
                      {entry.role === "assistant" ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{entry.content}</ReactMarkdown>
                      ) : (
                        <p>{entry.content}</p>
                      )}
                    </article>
                    {groups.map((group) => (
                      <ThinkingDisclosure key={group.key} group={group} />
                    ))}
                  </Fragment>
                );
              })}
              {snapshot.pendingConfirmation && (
                <ConfirmationCard
                  pending={snapshot.pendingConfirmation}
                  onResolve={(approved) =>
                    void backgroundClient
                      .send({
                        type: "confirm_action",
                        actionId: snapshot.pendingConfirmation?.intent.id ?? "",
                        approved,
                      })
                      .catch((reason) => setError(message(reason)))
                  }
                />
              )}
              <div ref={messageEnd} />
            </div>
            {snapshot.settings.provider && (
              <div className="model-bar">
                <select
                  aria-label="Provider profile"
                  value={snapshot.settings.activeProviderId ?? ""}
                  disabled={active || busy}
                  onChange={(event) => void switchProvider(event.target.value)}
                >
                  {snapshot.settings.providers.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
                <select
                  aria-label="Model"
                  value={chatModel || savedModel}
                  disabled={active || busy}
                  onChange={(event) => {
                    setChatModel(event.target.value);
                    void commitModel(event.target.value);
                  }}
                >
                  {chatModelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <button type="button" disabled={active || busy} onClick={() => void loadChatModels()}>
                  Load models
                </button>
              </div>
            )}
            <div className="composer">
              {active && (
                <button
                  className="stop"
                  onClick={() =>
                    void backgroundClient.send({ type: "stop_run", runId: snapshot.activeRun?.id })
                  }
                >
                  Stop
                </button>
              )}
              <textarea
                value={input}
                disabled={active || !snapshot.settings.provider}
                placeholder={active ? "Run in progress…" : "Ask BrowserAgent…"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void sendMessage();
                  }
                }}
              />
              <button
                disabled={active || !input.trim() || !snapshot.settings.provider}
                onClick={() => void sendMessage()}
              >
                Send
              </button>
            </div>
          </section>
        )}

        {view === "memory" && (
          <section className="panel">
            <div className="panel-heading">
              <div>
                <h2>Workspace memory</h2>
                <p>Only source-linked run capsules are reused.</p>
              </div>
              <button disabled={active} onClick={() => void startNewChat()}>
                New chat
              </button>
            </div>
            {snapshot.notes.length === 0 && <p className="muted">No page-backed notes yet.</p>}
            {snapshot.notes.map((note) => (
              <NoteCard key={note.id} note={note} onError={setError} />
            ))}
          </section>
        )}

        {view === "usage" && (
          <section className="panel">
            <h2>Token usage</h2>
            <div className="metrics">
              <Metric label="Input" value={usageTotals.input} />
              <Metric label="Cached" value={usageTotals.cached} />
              <Metric label="Output" value={usageTotals.output} />
              <Metric label="Total" value={usageTotals.total} />
            </div>
            <p className="muted">Estimated entries are marked with ≈. No currency estimate is invented.</p>
            <div className="usage-list">
              {[...snapshot.usage].reverse().map((entry) => (
                <div className="usage-row" key={entry.id}>
                  <span>
                    {entry.kind === "compaction" ? "compaction · " : ""}
                    {entry.estimated ? "≈" : ""}
                    {entry.total.toLocaleString()} total
                  </span>
                  <span>
                    {entry.input.toLocaleString()} in · {entry.cachedInput.toLocaleString()} cached ·{" "}
                    {entry.output.toLocaleString()} out
                  </span>
                  {entry.segments.length > 0 && (
                    <span>
                      {entry.segments.map((segment) => `${segment.kind} ${segment.tokens}`).join(" · ")}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

        {view === "settings" && (
          <section className="panel settings">
            <h2>Providers & API keys</h2>
            <p className="muted">
              Save a named profile for each endpoint or API key, including multiple keys for the same
              provider. Keys are stored locally, not encrypted. Switching is manual; there is no automatic
              fallback. Supports OpenAI Responses and Chat Completions-compatible endpoints.
            </p>
            <fieldset disabled={busy || active} className="provider-editor">
              <label>
                Profile to edit (Save makes it active)
                <select
                  value={draft.activeProviderId ?? ""}
                  onChange={(event) => editProfile(event.target.value)}
                >
                  {!draft.providers.length && <option value="">New provider</option>}
                  {draft.providers.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="actions">
                <button disabled={draft.providers.length >= 50} onClick={addProfile}>
                  Add provider / key
                </button>
                <button disabled={!draft.activeProviderId} onClick={removeProfile}>
                  Remove
                </button>
              </div>
              {draft.activeProviderId && (
                <label>
                  Profile name
                  <input
                    value={
                      draft.providers.find((profile) => profile.id === draft.activeProviderId)?.name ?? ""
                    }
                    maxLength={80}
                    placeholder="e.g. OpenRouter — personal key"
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        providers: current.providers.map((profile) =>
                          profile.id === current.activeProviderId
                            ? { ...profile, name: event.target.value }
                            : profile,
                        ),
                      }))
                    }
                  />
                </label>
              )}
              <label>
                Protocol
                <select
                  value={provider.protocol}
                  onChange={(event) =>
                    setDraftProvider(setDraft, provider, {
                      protocol: event.target.value as ProviderSettings["protocol"],
                      capabilities: EMPTY_CAPABILITIES,
                    })
                  }
                >
                  <option value="responses">OpenAI Responses</option>
                  <option value="chat_completions">Chat Completions</option>
                </select>
              </label>
              <label>
                API base URL
                <input
                  value={provider.baseUrl}
                  onChange={(event) =>
                    setDraftProvider(setDraft, provider, {
                      baseUrl: event.target.value,
                      availableModels: [],
                      capabilities: EMPTY_CAPABILITIES,
                    })
                  }
                />
              </label>
              <label>
                API key
                <input
                  type="password"
                  value={provider.apiKey}
                  autoComplete="off"
                  onChange={(event) =>
                    setDraftProvider(setDraft, provider, {
                      apiKey: event.target.value,
                      availableModels: [],
                      capabilities: EMPTY_CAPABILITIES,
                    })
                  }
                />
              </label>
              <label>
                Model picker
                <ModelPicker
                  value={provider.model}
                  models={provider.availableModels}
                  disabled={busy || active}
                  ariaLabel="Model picker"
                  onChange={(model) =>
                    setDraftProvider(setDraft, provider, {
                      model,
                      capabilities: EMPTY_CAPABILITIES,
                    })
                  }
                  onReload={() => void loadModels()}
                />
                <span className="field-help">
                  {provider.availableModels.length > 0
                    ? `${provider.availableModels.length.toLocaleString()} models available`
                    : "Load from /models or enter an ID manually"}
                </span>
              </label>
              <div className="two-column">
                <label>
                  Context window
                  <input
                    type="number"
                    min={8_000}
                    value={provider.contextWindow}
                    onChange={(event) =>
                      setDraftProvider(setDraft, provider, { contextWindow: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Output reserve
                  <input
                    type="number"
                    min={256}
                    value={provider.maxOutputTokens}
                    onChange={(event) =>
                      setDraftProvider(setDraft, provider, { maxOutputTokens: Number(event.target.value) })
                    }
                  />
                </label>
                <label>
                  Max thinking turns
                  <input
                    type="number"
                    min={1}
                    max={TOKEN_LIMITS.maximumThinkingTurns}
                    value={provider.maxThinkingTurns}
                    onChange={(event) =>
                      setDraftProvider(setDraft, provider, {
                        maxThinkingTurns: Math.min(
                          TOKEN_LIMITS.maximumThinkingTurns,
                          Math.max(1, Number(event.target.value) || 1),
                        ),
                      })
                    }
                  />
                </label>
              </div>
              <div className="prompt-budget">
                <span>Stable prompt</span>
                <strong>≈{estimateTokens(CORE_INSTRUCTIONS).toLocaleString()} tokens</strong>
                <span>Tool schemas</span>
                <strong>≈{TOOL_DEFINITION_TOKENS.toLocaleString()} tokens</strong>
              </div>
              <div className="capabilities">
                {Object.entries(provider.capabilities).map(([name, enabled]) => (
                  <span className={enabled ? "cap enabled" : "cap"} key={name}>
                    {name}
                  </span>
                ))}
              </div>
              <div className="actions">
                <button disabled={busy || active} onClick={() => void testProvider()}>
                  Test
                </button>
                <button className="primary" disabled={busy || active} onClick={() => void saveSettings()}>
                  Save
                </button>
              </div>
            </fieldset>
          </section>
        )}
      </main>
    </div>
  );
}

function handleEvent(
  event: AgentEvent,
  setSnapshot: (value: AppSnapshot) => void,
  setStream: Dispatch<SetStateAction<ActiveStream | null>>,
  setNotice: (value: string) => void,
  setError: (value: string) => void,
): void {
  if (event.type === "stream_reset") {
    const payload =
      event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
    setStream(
      event.runId && typeof payload.turn === "number"
        ? { runId: event.runId, turn: payload.turn, text: "" }
        : null,
    );
    return;
  }
  if (event.type === "stream_delta" && event.payload && typeof event.payload === "object") {
    const payload = event.payload as Record<string, unknown>;
    const runId = event.runId;
    const turn = payload.turn;
    const delta = payload.text;
    if (runId && typeof turn === "number" && typeof delta === "string") {
      setStream((current) => ({
        runId,
        turn,
        text: current?.runId === runId && current.turn === turn ? current.text + delta : delta,
      }));
    }
    return;
  }
  if (event.type === "state") {
    const parsed = appSnapshotSchema.safeParse(event.payload);
    if (parsed.success) {
      setSnapshot(parsed.data);
      if (!parsed.data.activeRun) setStream(null);
    }
    return;
  }
  const value =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>).message
      : undefined;
  if (typeof value === "string") {
    if (event.type === "error") setError(value);
    else setNotice(value);
  }
}

function ThinkingDisclosure(props: { group: ThinkingGroup }) {
  const { group } = props;
  return (
    <details
      className={`thinking${group.working ? " active" : ""}${group.failed ? " failed" : ""}`}
      open={group.working}
    >
      <summary>
        <span>Thinking</span>
        <span>{group.working ? "working" : group.failed ? "stopped" : "saved"}</span>
      </summary>
      <div className="thinking-content">
        {group.contents.length > 0 ? (
          group.contents.map((content, index) => (
            <ReactMarkdown key={index} remarkPlugins={[remarkGfm]}>
              {content}
            </ReactMarkdown>
          ))
        ) : (
          <p className="muted">{group.working ? "Working…" : "No visible commentary was emitted."}</p>
        )}
        {group.tools.length > 0 && (
          <p className="thinking-tools">Tools: {[...new Set(group.tools)].join(", ")}</p>
        )}
      </div>
    </details>
  );
}

function ModelPicker(props: {
  value: string;
  models: string[];
  disabled: boolean;
  ariaLabel: string;
  onChange: (model: string) => void;
  onReload: () => void;
}) {
  return (
    <div className="model-picker">
      <input
        value={props.value}
        list="provider-model-options"
        aria-label={props.ariaLabel}
        placeholder="Choose or enter a model ID"
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <datalist id="provider-model-options">
        {props.models.map((model) => (
          <option value={model} key={model} />
        ))}
      </datalist>
      <button type="button" disabled={props.disabled} onClick={props.onReload}>
        Load models
      </button>
    </div>
  );
}

function setDraftProvider(
  setter: Dispatch<SetStateAction<AppSettings>>,
  provider: ProviderSettings,
  patch: Partial<ProviderSettings>,
): void {
  setter((current) => ({ ...current, provider: { ...provider, ...patch } }));
}

function EmptyCard(props: { title: string; text: string; action: string; onAction: () => void }) {
  return (
    <div className="empty-card">
      <strong>{props.title}</strong>
      <p>{props.text}</p>
      <button onClick={props.onAction}>{props.action}</button>
    </div>
  );
}

function ConfirmationCard(props: {
  pending: NonNullable<AppSnapshot["pendingConfirmation"]>;
  onResolve: (approved: boolean) => void;
}) {
  const { intent } = props.pending;
  return (
    <aside className="confirmation">
      <strong>Confirm {intent.tool}</strong>
      <p>{intent.target ?? intent.classification}</p>
      <pre>{JSON.stringify(intent.redactedArgs, null, 2)}</pre>
      <div>
        <button onClick={() => props.onResolve(false)}>Deny</button>
        <button className="primary" onClick={() => props.onResolve(true)}>
          Allow
        </button>
      </div>
    </aside>
  );
}

function NoteCard(props: { note: WorkspaceNote; onError: (error: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(props.note.title);
  const [content, setContent] = useState(props.note.content);
  const save = async () => {
    try {
      await backgroundClient.send({ type: "update_note", noteId: props.note.id, title, content });
      setEditing(false);
    } catch (reason) {
      props.onError(message(reason));
    }
  };
  return (
    <article className="note">
      {editing ? (
        <>
          <input value={title} onChange={(event) => setTitle(event.target.value)} />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
        </>
      ) : (
        <>
          <h3>{props.note.title}</h3>
          <p>{props.note.content}</p>
        </>
      )}
      <div className="sources">
        {props.note.sources.map((source) => (
          <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
            {source.title || source.url}
          </a>
        ))}
      </div>
      <div className="actions">
        {editing ? (
          <button onClick={() => void save()}>Save</button>
        ) : (
          <button onClick={() => setEditing(true)}>Edit</button>
        )}
        <button
          onClick={() =>
            void backgroundClient
              .send({ type: "delete_note", noteId: props.note.id })
              .catch((reason) => props.onError(message(reason)))
          }
        >
          Delete
        </button>
      </div>
    </article>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{props.value.toLocaleString()}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

async function requestProviderAccess(baseUrl: string): Promise<void> {
  const origin = providerOriginPattern(baseUrl);
  const granted = await browser.permissions.request({ origins: [origin] });
  if (!granted) {
    throw new Error(`Firefox access to ${new URL(baseUrl).hostname} is required for provider requests`);
  }
}
