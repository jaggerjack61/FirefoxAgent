# BrowserAgent

A production-ready Firefox extension that turns your browser into an AI agent. Type natural-language commands — *"Summarize this page"*, *"Compare the laptops in these three tabs"*, *"Search for the latest sidebar docs and give me the important points"* — and the agent reads, navigates, compares and acts across **multiple tabs** while keeping one continuous conversation.

Works with **any OpenAI-compatible API** (OpenAI, DeepSeek, Ollama, LM Studio, vLLM, …), including local servers and models without native tool calling.

> **Architecture principle:** *The model decides what it wants to do, but trusted extension code decides what it is allowed to do and performs the actual browser operation.*

---

## Features

- **Persistent sidebar chat** (Firefox `sidebar_action`) with streaming responses
- **Real browser control** through WebExtension APIs + content scripts — no fake "the agent would click X" responses
- **Multi-tab workspace context** — per-tab summaries and facts (`Tab 3 = Lenovo, $1,499, 32GB`) survive tab switches
- **Current-page by default** — commands apply to the active page unless you explicitly mention another/new/background tab
- **Stable element IDs** (`[3] link "Pricing"` → `click_element(3)`) with semantic re-matching when the DOM changes
- **Reliable interactions** with auto-waiting for visible, enabled, editable, stable and unobscured controls before click/fill actions
- **Prompt-injection defense** — web content is wrapped as untrusted data; the LLM can never be hijacked by a page
- **Confirmation enforcement outside the model layer** — checkout, delete, send, login and password actions always ask the user first
- **Context compression + token budgeting** — long research sessions keep working without blowing the model's context window
- **Session persistence** (IndexedDB) — conversations, workspaces, task state and provider settings survive restarts
- **Stop button**, action history, undo (closed tabs / input values), developer mode
- **Privacy controls** — choose what page data may be sent; password fields are always excluded

## Quick start

### 1. Install dependencies & build

```bash
npm install
npm run build      # icons + background + content + sidebar -> dist/
```

### 2. Load in Firefox (development)

1. Open `about:debugging#/runtime/this-firefox`
2. Click **Load Temporary Add-on…**
3. Select `dist/manifest.json`

The toolbar button opens the **BrowserAgent** sidebar. (In an installed/packaged build the sidebar is available from the browser sidebar menu.)

### 3. Configure a provider

The extension ships pre-configured for **DeepSeek**:

- Base URL: `https://api.deepseek.com` (the provider appends `/chat/completions`)
- Model: `deepseek-chat`
- API key: set in **Settings → AI Provider**

For any other OpenAI-compatible endpoint (OpenAI, Ollama, LM Studio, …):

1. Open **Settings → AI Provider**
2. Set the provider name, base URL, API key and model
3. Click **Test connection** — this calls `GET {baseUrl}/models` (with your API key) and lists the available models
4. Choose protocol: `chat/completions` (universal) or `responses` (OpenAI native)
5. Adjust temperature / max tokens / context limit / timeout as needed

### 4. Grant site access

The extension needs **site access** to inject its content scripts. Click **Settings → Privacy & access → Grant site access** (this requests the `<all_urls>` optional host permission at runtime — nothing is required at install time).

### 5. Chat

Type something like:

- “Summarize this page.”
- “Compare the products in these three tabs.”
- “Which one was cheapest?”
- “Take the reference number from this tab and put it into the form in the other tab, but do not submit it.”

## Supported APIs

| Protocol | Endpoint | Support |
| --- | --- | --- |
| OpenAI-compatible chat | `POST {baseUrl}/chat/completions` | streaming, tool calls, structured output |
| OpenAI Responses API | `POST {baseUrl}/responses` | streaming, tool calls |
| Model listing | `GET {baseUrl}/models` | settings “Test connection” |

Models without native function calling are supported through an optional **structured-output fallback**: the agent sends its tool definitions as JSON instructions and parses `{"tool_calls": [...]}` from the reply.

## Permissions (least privilege)

| Permission | Why |
| --- | --- |
| `storage` | Settings + persisted state |
| `tabs` | List/switch/open/close tabs for the agent |
| `scripting` | Register content scripts after site access is granted |
| `activeTab` | Inspect the active tab before host access is granted |
| `sessions` | Restore recently closed tabs (undo) |
| `webNavigation` | Frame detection for iframe-aware snapshots |
| `webRequest` | Per-tab fetch/XHR/beacon completion tracking for bounded network-idle readiness; request bodies and headers are not read or stored |
| `optional_host_permissions: <all_urls>` | **Not required at install** — requested at runtime when you grant site access |

See [SECURITY.md](SECURITY.md) for the full threat model.

## Development

```bash
npm run typecheck      # strict TypeScript
npm test               # unit + integration tests (Vitest)
npm run test:e2e       # build + Playwright UI tests (sidebar against a mocked runtime)
npm run start:firefox  # build + web-ext run (launches Firefox with the extension)
npm run package        # build + web-ext build -> web-ext-artifacts/*.zip
```

### Project layout

```
src/
├── background/     # Firefox background script: orchestrator, gateway, tab coordinator
├── content/        # content script: snapshots, element ids, interaction, extractors
├── sidebar/        # React UI (chat, context, history, settings, dev)
├── agent/          # agent loop, task state, confirmation manager, context builder, compression
├── providers/      # LLM provider layer (OpenAI-compatible, streaming, retry, capabilities)
├── tools/          # tool registry + all browser tools (zod-validated)
├── workspace/      # workspace context manager (multi-tab state)
├── memory/         # IndexedDB persistence
├── settings/       # settings repository (WebExtension storage)
├── security/       # confirmation policy, injection defense, privacy gating
└── shared/         # types, message protocol, errors, tokens, redaction
```

See [ARCHITECTURE.md](ARCHITECTURE.md) and [TESTING.md](TESTING.md).

## Privacy

- Page content may be sent to the configured AI provider **only when necessary to perform a request**, and only as permitted by Settings → Privacy & access.
- Firefox's install prompt discloses the data sent to that provider: the API credential, browsing and website content/activity, search terms, and chat instructions. Firefox 140 or newer is required so this consent is handled by Firefox's built-in data-collection permission flow.
- **Password inputs are always excluded** from page snapshots, in every mode.
- API keys live only in extension storage; they are never injected into pages, never exposed to page JavaScript, and always redacted from dev views and logs.
- Raw page contents are **not** persisted. The extension stores summaries, facts and task state only.

## License

MIT — see `LICENSE`.
