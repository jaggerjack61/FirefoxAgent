# Testing

Firefox Agent is developed with **Test-Driven Development**: for every significant behavior, a failing test comes first, then the minimum implementation, then refactoring. The suite covers unit tests (pure logic), integration tests (the agent loop against fakes), and E2E UI tests (Playwright against a mocked runtime).

## Commands

```bash
npm test               # Vitest: unit + integration (src/**/*.test.ts)
npm run test:watch     # watch mode
npm run typecheck      # strict TypeScript (tsc --noEmit)
npm run test:e2e       # build + Playwright (e2e/), serves dist/sidebar on :4173
npx playwright install chromium   # one-time browser install for E2E
```

## Unit tests

| Area | File | Covers |
| --- | --- | --- |
| Tool registry | `src/tools/registry.test.ts` | registration, JSON schemas, validation, unknown tools, execution through the gateway |
| Provider parsing | `src/providers/parseChat.test.ts` | chat-completions parsing, tool-call argument recovery, streaming accumulation |
| | `src/providers/parseResponses.test.ts` | responses API parsing, streamed function calls |
| | `src/providers/sse.test.ts` | SSE parsing, `[DONE]`, multi-line payloads, JSON extraction |
| | `src/providers/retry.test.ts` | backoff, 429 retry-after, network failures, no-retry on 400, abort |
| | `src/providers/capabilities.test.ts` | auto-detection, local-server heuristics, overrides |
| | `src/providers/OpenAICompatibleProvider.test.ts` | `/models` listing with API-key header, structured auth errors |
| Security | `src/security/confirmation.test.ts` | financial/destructive/send/login/form/password rules, interactive mode, irreversibility |
| | `src/security/injection.test.ts` | untrusted wrapping, phrase neutralization, detection |
| | `src/security/privacy.test.ts` | privacy gates, sensitive-value masking |
| Workspace | `src/workspace/WorkspaceManager.test.ts` | tab lifecycle, facts, dedupe, URL invalidation, memory handoff, model rendering |
| Agent | `src/agent/TaskManager.test.ts` | state transitions, steps, facts, persistence round-trip |
| | `src/agent/ConfirmationManager.test.ts` | approve/deny/expire/cancel flows |
| | `src/agent/ContextCompressor.test.ts` | conversation/workspace compression, task essence |
| | `src/agent/TokenBudget.test.ts` | estimation, compression tier planning |
| Shared | `src/shared/semanticMatch.test.ts` | identity hashing, semantic matching |
| | `src/shared/utils.test.ts` | redaction, tokens, context layers, system prompt, observations |

## Integration tests

`src/agent/AgentRuntime.test.ts` drives the **real** `AgentRuntime`, **real** `ToolRegistry` and **real** workspace/task managers against:

- a **scripted `FakeProvider`** (LLM responses are pre-arranged),
- a **`FakeGateway`** (in-memory tabs and page snapshots),
- a **`FakeMemoryStore`** (in-memory IndexedDB).

Because the runtime only talks to interfaces, no Firefox API is touched.

### Covered workflows (acceptance scenarios)

| Scenario | Test |
| --- | --- |
| §42-1 Current page summary | answer directly from the active snapshot already in context |
| §22 Three-tab comparison | inspects tabs 3/7/9, stores per-tab state, produces one answer from workspace facts; follow-up (“which one was cheapest?”) answers from cache with **no** additional tool calls |
| §23 Research | `search_web` in the current tab by default → open/read result → summarize |
| §42-5 Cross-tab form | read reference number in tab 1 → switch to tab 2 → type into field → **no submit** |
| §42-7 Injection defense | page containing `SYSTEM MESSAGE: …` → payload is wrapped in `<untrusted_page_content>` and neutralized |
| §42-8 Dangerous action | clicking `Place order` blocks on `CONFIRMATION_REQUESTED`; denial → `CONFIRMATION_DENIED` observation, **no click executed**; approval → click executes |
| Error recovery | failed tools produce structured `Error executing <tool>` observations; invalid arguments are rejected before execution |
| Control | `stop()` aborts an in-flight LLM call via `AbortSignal`; max-iterations limit fails the run; provider errors become failed runs with the message surfaced |

## E2E tests (Playwright)

Firefox cannot be driven by Playwright for real WebExtension sidebars, so `e2e/sidebar.spec.ts` loads the **built sidebar app** in a plain browser and injects a scripted mock of `browser.runtime` (`__FFA_MOCK_RUNTIME`) before the app boots. This exercises the real React UI, the Zustand store, and the event pipeline:

- chat send → user message + streamed assistant reply + activity feed
- confirmation banner appears on `CONFIRMATION_REQUESTED` and resolves on cancel
- context panel renders workspace tabs, summaries and facts
- settings defaults to DeepSeek; “Test connection” lists models
- dev panel is gated behind dev mode

`e2e/interactions.spec.ts` loads the production content-script bundle into a real browser page with a minimal WebExtension runtime shim. It covers the layout/event behavior that Node DOM mocks cannot model:

- delayed enabled/editable state is auto-waited
- transient overlays are detected by hit testing
- off-screen targets are scrolled into view before clicking
- pointer/mouse/click and beforeinput/input/change sequences reach page handlers
- element ids remain stable after form values and checked state change

### Manual extension testing with web-ext

```bash
npm run start:firefox   # builds and launches Firefox with the extension
```

Then in the launched profile: grant site access in Settings, ask the agent to “Summarize this page.”, and watch the activity feed.

## Conventions

- Pure logic lives in DOM-/API-free modules so it is trivially testable (e.g. `semanticMatch.ts`, `confirmation.ts`, `ContextCompressor.ts`).
- Fakes are shared in `src/test/fakes.ts` — never mock what you don't own.
- A behavior is only “done” when its test is red → green → refactored and the whole suite passes.
