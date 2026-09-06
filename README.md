# BrowserAgent

BrowserAgent is a token-first Firefox sidebar agent. It can discuss a page, work across tabs, and complete forms through a user-supplied OpenAI Responses or OpenAI-style Chat Completions endpoint.

The v1 implementation is a scratch rewrite. Every provider request is compiled by one budget-aware context compiler; page content is never attached automatically, the model sees exactly 15 browser tools, and raw page bodies and form values are never retained as memory.

## What it does

- Streams a persistent sidebar conversation backed by IndexedDB.
- Keeps visible model progress from every tool turn in permanent, collapsible chat entries.
- Starts a clean chat by clearing the current conversation and its workspace memory while retaining settings.
- Controls any permitted HTTP(S) tab through revision-bound semantic element handles.
- Reads pages through query-ranked, paginated semantic blocks rather than `body.innerText` dumps. Text-only and controls-only modes keep reads focused; the whole JSON result fits the requested estimated token budget.
- Discovers subframes and reads open shadow DOM. Checks visibility, occlusion, disabled/read-only state, and target identity before interactions.
- Saves up to 50 named provider/key profiles, including multiple keys for the same endpoint, with independent models, budgets, and capabilities.
- Supports OpenAI Responses and OpenAI-style Chat Completions wire formats (not native Anthropic or Gemini APIs).
- Loads an endpoint's available models and tests capabilities instead of guessing from names or URLs.
- Switches models from a dropdown above the chat input; the choice is saved immediately.
- Enforces Interactive, Agent, and session-only YOLO action policies outside the model.
- Displays per-request and per-run token usage, cache usage, compactions, and context-segment estimates.
- Recovers safely from background restarts by interrupting unfinished runs without replaying actions.
- Stop cancels hung provider streams, pending confirmations, and in-flight page waits; a mutation already dispatched to the page is marked unverified rather than assumed complete.
- Consecutive thinking turns collapse into one block, split only when a browser action is actually taken.

## Install for development

Requirements: Node.js 20 or newer and Firefox 140 or newer.

```bash
npm install
npm run build
```

Open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `dist/manifest.json`. The toolbar action opens the BrowserAgent sidebar.

On first use:

1. Open **Settings**.
2. Choose Responses or Chat Completions, then enter the base URL, optional bearer key, context window, and output reserve.
3. Click **Load models** and pick a model, or enter its ID manually. You can switch models at any time from the dropdown above the chat input.
4. Click **Test**. Firefox requests access only to the provider origin and the test records capabilities actually accepted by the endpoint.
5. Click **Save**.
6. Grant optional website access when prompted.

To add another provider or key, choose **Add provider / key**, name the profile, configure it, and **Save**. Use one profile per key—even for the same endpoint. The profile and model dropdowns above chat switch saved configurations while idle. Changes in Settings are drafts until saved; **Remove**, then **Save**, deletes a profile and its key. Existing single-provider settings migrate automatically.

Keys are stored in Firefox local extension storage, **not encrypted**. Only the selected profile's credential is used; there is no automatic rotation or cross-provider fallback. Switching providers also sends that conversation's selected context to the new provider; start a new chat if it should not be shared. Provider requests reject redirects and omit cookies. BrowserAgent has no backend, telemetry, analytics, or price database.

## Token policy

Defaults are deliberately conservative:

| Limit                         |                        Default |
| ----------------------------- | -----------------------------: |
| Unknown model context         |                  32,000 tokens |
| Minimum supported context     |                   8,000 tokens |
| Output reserve                |                   2,048 tokens |
| Input soft limit              |                 70% of context |
| Input hard limit              | context − output reserve − 10% |
| Total run limit               |                     4× context |
| Recent conversation           |         6 user/assistant pairs |
| Workspace notes               |                     800 tokens |
| Default / maximum page result |             900 / 2,000 tokens |
| Other tool result             |                     120 tokens |
| Tab/frame list result         |                     600 tokens |
| Compacted summary             |                     700 tokens |

Provider-side automatic truncation is not used. Optional segments are omitted in priority order, older Chat Completions history is compacted only at the soft limit, and required context that cannot fit produces a visible budget error.

## Browser tools

The complete model-visible catalog is:

`list_tabs`, `open_tab`, `activate_tab`, `close_tab`, `navigate`, `go_back`, `reload`, `read_page`, `list_frames`, `wait_for`, `click`, `fill`, `select`, `set_checked`, and `submit`.

Use `read_page` with `mode: "controls"` to locate targets or `mode: "text"` for research (`all` is the default). All controls are paginated, not capped at the first 120. Continue with the returned `nextCursor`, keeping query, mode, and frame unchanged. Stale cursors and changed targets require a fresh read, not a guessed handle. Tiny budgets that cannot fit one complete item return an explicit error.

Fills use native setters; checkbox changes use native click activation so framework handlers run. Disabled, covered, ambiguous, and read-only targets fail explicitly. Clicks/submissions without a verifiable outcome return `unverified`; inspect before retrying to avoid duplicate effects. Rich/contenteditable editors, multi-selects, closed shadow roots, and sites requiring trusted hardware events remain unsupported.

There is no model-supplied JavaScript, keyboard dispatch, file upload/download, hidden executable tool, or arbitrary extraction alias.

## Safety modes

- **Interactive** confirms every browser mutation.
- **Agent** confirms submissions, non-navigation controls, tab closure, and unclear effects.
- **YOLO** executes valid tools without confirmation. It is opt-in, visibly warned, and never persisted across a browser session.

All modes still enforce URL restrictions, schema validation, stale-handle rejection, privacy filtering, token/action/time limits, and target-specific postcondition verification.

## Development commands

```bash
npm run typecheck       # strict TypeScript
npm run lint            # ESLint
npm run format          # formatting check
npm test                # offline unit/integration tests
npm run test:coverage   # coverage and thresholds
npm run token:budgets   # reviewed stable-prefix counts
npm run build           # production extension
npm run lint:addon      # web-ext lint on dist
npm run package         # exact Firefox ZIP
npm run test:e2e        # Firefox profile persistence + real-DOM interaction tests
npm run check           # complete local verification except packaged E2E
npm audit --omit=dev    # production dependency audit
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the execution and prompt model.

## License

MIT — see [LICENSE](LICENSE).
