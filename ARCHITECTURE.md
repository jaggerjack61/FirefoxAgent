# Architecture

Firefox Agent is a WebExtension (Manifest V3, Firefox-flavored) with three independent bundles: **background script**, **content script** and **sidebar React app**.

## Process model

```
┌─────────────────────────────── Firefox ───────────────────────────────┐
│                                                                        │
│  Sidebar UI (React + Zustand)          Background script (MV3)         │
│  ┌──────────────────────────┐          ┌───────────────────────────┐   │
│  │ Chat / Context / History │◄────────►│ BackgroundOrchestrator    │   │
│  │ Settings / Dev           │  typed   │   ├─ AgentRuntime (loop)  │   │
│  │                          │  runtime │   ├─ ToolRegistry         │   │
│  │ (web page of the         │  messages│   ├─ WorkspaceManager     │   │
│  │  extension origin)       │          │   ├─ TaskManager          │   │
│  └──────────────────────────┘          │   ├─ ConfirmationManager  │   │
│                                        │   ├─ LLMProvider          │   │
│                                        │   └─ FirefoxGateway       │   │
│                                        │              │            │   │
│                                        │              ▼            │   │
│                                        │        TabCoordinator     │   │
│                                        └──────────────┬────────────┘   │
│                                                       │ tabs.sendMessage│
│  Content script (in every inspected web page)         ▼                 │
│  ┌─────────────────────────────────────────────────────────────┐        │
│  │ ElementRegistry · SnapshotBuilder · interactions ·          │        │
│  │ extractors · DomObserver (SPA detection)                    │        │
│  └─────────────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────────┘
```

**Content scripts never call the LLM.** All API communication happens in the background, in the extension's trusted origin.

## Layering

The strict dependency direction is:

```
shared  ←  security  ←  tools  ←  agent  ←  background
   ↑         ↑           ↑        ↑          ↑
   └─────────┴───────────┴────────┴──────────┘   (nothing depends downward)
```

### `src/shared` — contracts
- `types.ts` — LLM messages, provider config, settings, workspace, task, confirmation, dev events
- `protocol.ts` — typed sidebar↔background request/response unions (no loosely typed messaging)
- `contentProtocol.ts` — typed background↔content protocol; frame-scoped element ids (`E3`, `5:E3`)
- `browserGateway.ts` — the **only** interface through which the agent touches the browser
- `errors.ts` — structured error codes with `suggestedAction` recovery hints
- `semanticMatch.ts` — pure element identity hashing + semantic matching (stale-element recovery)
- `redact.ts`, `tokens.ts`, `id.ts` — secret redaction, token estimation, ids/time

### `src/security` — enforcement outside the model
- `confirmation.ts` — pure, mode-aware rules: Interactive requires approval for meaningful actions, Agent requires approval for high-risk actions, and YOLO bypasses confirmations
- `injection.ts` — untrusted-data wrapping (`<untrusted_page_content>`), instruction-phrase neutralization, injection detection
- `privacy.ts` — privacy gates: what page data may leave the extension, sensitive-field masking

### `src/tools` — the tool layer
`ToolRegistry` is the single source of truth for:
- available tools (names/descriptions)
- LLM-facing JSON schemas (generated from zod via `zod-to-json-schema`)
- validation (`validateCall` — model output is never trusted)
- execution (`executeCall` with a typed `ToolContext`)

The registry keeps the full compatibility catalog, but each request exposes only a task-relevant subset. Current-page interaction, inspection, and direct-download tools are the default; cross-tab, memory, history and undo tools are added only when the user explicitly refers to those scopes. `download_file` delegates HTTP(S) transfers of any MIME type to Firefox's download manager, so large files never enter agent memory. Overlapping legacy aliases remain executable but are hidden from the model.

### `src/agent` — the runtime
- `AgentRuntime.run(userText)` implements the loop:

```
send user request → build context → LLM →
  if final text → return
  if tool calls → validate each → confirmation policy →
                 execute sequentially → observation → repeat
until: final response | awaiting user | max iterations | timeout | error | stopped
```

- `ContextBuilder` — five context layers (system, conversation, active tab, workspace, task) + tool observations, all wrapped per the injection rules
- `TokenBudget` — estimates every layer; plans compression tiers (drop active-tab text → compress conversation → facts-only workspace → drop tool descriptions)
- `ContextCompressor` — verbatim recent messages, summarized older ones, preserved goals/facts
- `TaskManager` — explicit `AgentTask` state machine, persisted to IndexedDB
- `ConfirmationManager` — pending approval requests; the loop **blocks** until the user decides; denial is fed back to the model as `CONFIRMATION_DENIED`; the LLM has no path to approve its own actions

### `src/providers` — the LLM layer
`LLMProvider` interface (`send`, `supportsToolCalling`, `supportsStreaming`, `capabilities`, optional `listModels`). The OpenAI-compatible implementation supports:
- `POST {baseUrl}/chat/completions` and `POST {baseUrl}/responses`
- SSE streaming with delta accumulation
- tool-call argument parsing with malformed-JSON recovery (markdown fences, embedded objects)
- retry with backoff for 429/5xx/network errors, per-attempt timeouts
- capability auto-detection (local servers → no tools) with user overrides
- structured-output fallback for models without function calling (`{"tool_calls": [...]}`)

### `src/workspace` — cross-tab context
`WorkspaceManager` keeps per-tab `{summary, importantFacts, extractedEntities, lastInspectedAt, pageChangedSinceInspection}`. Facts are stale-marked when a tab's URL changes; closed tabs keep their facts in long-term memory. `renderForModel()` produces the compact workspace block the LLM sees — never raw page contents.

### `src/memory` / `src/settings`
- `IndexedDbMemoryStore` — conversations, messages, workspace, facts, tasks, provider config
- `WebExtensionSettingsRepository` — settings in `storage.local`, provider config (with API key) in IndexedDB

### `src/background` — wiring
- `FirefoxGateway` — real implementation of `BrowserGateway`: tab ops, navigation with document-plus-network-idle waiting, per-tab fetch/XHR/beacon accounting with a bounded fallback for polling/streaming sites, content-script registration after optional permission grant, snapshot caching + invalidation, stale-element recovery (refresh snapshot → semantic match → retry once), compact observation formatting
- `TabCoordinator` — tab lifecycle events → workspace sync (URL changes, closes, activations), closed-tab records for undo
- `Orchestrator` — owns runtime/workspace/tasks/confirmations, message persistence, dev-event buffer (redacted)
- `index.ts` — router for the typed sidebar protocol + content-script notifications

### `src/sidebar` — React UI
Zustand store mirroring background state through pushed events (`MESSAGE_ADDED`, `STREAM_DELTA`, `ACTIVITY`, `CONFIRMATION_REQUESTED`, `WORKSPACE_CHANGED`, `AGENT_STATE`, `DEV_EVENT`). Views: Chat (with activity feed and confirmation banner), Context (workspace tabs, pin/add/remove), History (action log + data controls), Settings (provider with **Test connection** → `/models`, mode, limits, privacy, memory, dev mode), Dev (context sizes, tool calls, LLM requests — redacted).

## Message protocol

All internal messages are discriminated unions:

```ts
// sidebar → background
{ type: "SEND_USER_MESSAGE"; text: string }
{ type: "WORKSPACE_ADD_TAB"; tabId: number; pinned?: boolean }
{ type: "CONFIRMATION_RESPONSE"; requestId: string; approved: boolean }
{ type: "FETCH_MODELS" }
…

// background → content (routed per frame)
{ kind: "get_snapshot"; opts?: SnapshotRequestOptions; frameId: number }
{ kind: "click"; elementId: string }      // frame-scoped: "E3" | "5:E3"
{ kind: "describe_element"; elementId: string }
…

// content → background
{ type: "PAGE_CHANGED"; url: string; reason: "history" | "mutation" | "navigation" }
```

## Key flows

### Element interaction
1. The runtime includes the active page's semantic map with stable ids in every task context: `[1] input "Email"` …
2. The model directly requests `click_element(elementId: "3")`; it does not perform a redundant snapshot preflight.
3. The registry validates the element still exists **and its identity hash matches** (DOM mutations invalidate).
4. Pointer actions use a [Playwright-inspired actionability model](https://playwright.dev/docs/actionability): auto-wait for visible, enabled, stable and unobscured; scroll into view; then dispatch the pointer/mouse/click sequence.
5. Text filling auto-waits for visible, enabled and editable; uses the native value setter; emits `beforeinput`, `input` and `change`; and reports whether the page retained the requested value.
6. Mutable form state (`value`, `checked`) is not part of element identity, so the same id remains valid after filling or toggling a control.
7. On `ELEMENT_NOT_FOUND`: snapshot is refreshed, the stale element is matched semantically (role+name+type+href scoring), and the action retries once with the new id. The agent is never silently pointed at an unrelated element.

Content-script events are necessarily synthetic (`isTrusted === false`); unlike Playwright, a WebExtension has no browser-protocol input channel. The readiness checks, browser activation behavior and post-action verification provide the reliable subset available to an extension.

### Cross-tab comparison
`list_tabs` → inspect tab A (`summarize_tab`, which stores a local summary and key facts) → … → the runtime injects the compact combined workspace context → the LLM answers from facts, not raw pages. Follow-ups ("which one was cheapest?") reuse cached facts with zero tool calls.

### Confirmation enforcement
`executeToolCall` → schema validation → `evaluateConfirmation` (pure rules, mode-aware) → if required: task goes `awaiting_user`, a `ConfirmationRequest` is pushed to the sidebar, and the loop **awaits the user's decision**. Denial becomes a `CONFIRMATION_DENIED` observation; the model continues. YOLO mode explicitly bypasses both policy-derived and tool-declared confirmations while leaving schema validation, privacy gates, page scope, action budgets, and timeouts intact.

## Build

Three Vite builds (`vite.background.config.ts`, `vite.content.config.ts`, `vite.sidebar.config.ts`) run via `scripts/build.mjs`; `scripts/copy-static.mjs` copies `manifest.json` + generated icons into `dist/`. The manifest uses Firefox MV3 (`background.scripts`, `sidebar_action`).
