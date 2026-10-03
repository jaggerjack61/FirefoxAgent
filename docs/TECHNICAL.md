# BrowserAgent token policy and browser tools

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
| Tab/frame/search list result  |                     600 tokens |
| Compacted summary             |                     700 tokens |

Provider-side automatic truncation is not used. Optional segments are omitted in priority order, older Chat Completions history is compacted only at the soft limit, and required context that cannot fit produces a visible budget error.

## Browser tools

The complete model-visible catalog is:

`list_tabs`, `open_tab`, `activate_tab`, `close_tab`, `navigate`, `go_back`, `reload`, `read_page`, `list_frames`, `wait_for`, `search_history`, `search_bookmarks`, `click`, `fill`, `select`, `set_checked`, and `submit`.

`search_history` and `search_bookmarks` query local browsing history and saved bookmarks by title/URL text without opening pages. Results are bounded (50 items maximum, 600-token budget) and restricted to HTTP(S) URLs; both tools are read-only and never require confirmation. Using them requires the `history` and `bookmarks` Firefox permissions, which are requested at install.

Use `read_page` with `mode: "controls"` to locate targets or `mode: "text"` for research (`all` is the default). All controls are paginated, not capped at the first 120. Continue with the returned `nextCursor`, keeping query, mode, and frame unchanged. Stale cursors and changed targets require a fresh read, not a guessed handle. Tiny budgets that cannot fit one complete item return an explicit error.

Fills use native setters; checkbox changes use native click activation so framework handlers run. Disabled, covered, ambiguous, and read-only targets fail explicitly. Clicks/submissions without a verifiable outcome return `unverified`; inspect before retrying to avoid duplicate effects. Rich/contenteditable editors, multi-selects, closed shadow roots, and sites requiring trusted hardware events remain unsupported.

There is no model-supplied JavaScript, keyboard dispatch, file upload/download, hidden executable tool, or arbitrary extraction alias.

## Safety modes

- **Interactive** confirms every browser mutation.
- **Agent** confirms submissions, non-navigation controls, tab closure, and unclear effects.
- **YOLO** executes valid tools without confirmation. It is opt-in, visibly warned, and never persisted across a browser session.

All modes still enforce URL restrictions, schema validation, stale-handle rejection, privacy filtering, token/action/time limits, and target-specific postcondition verification.

Each provider profile sets a maximum number of thinking turns (default 12). The per-run action, time, and token ceilings scale with it. Enabling **Unlimited turns** removes all of these run ceilings, so a run continues until the model answers or you press Stop and its token usage is uncapped. Older tool results are still elided to keep each request within the context budget.

## Development commands

```bash
npm run typecheck
npm run lint
npm run format
npm test
npm run test:coverage
npm run token:budgets
npm run build
npm run lint:addon
npm run package
npm run test:e2e
npm run check
npm audit --omit=dev
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the execution and prompt model.
