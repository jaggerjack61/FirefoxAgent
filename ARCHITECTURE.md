# BrowserAgent v1 architecture

BrowserAgent is a Firefox Manifest V3 extension with three bundles: a background execution core, a page content script, and a React sidebar. The background is the only process that contacts the configured provider.

## Request path

```text
Sidebar command
  → Zod-validated UiCommand
  → single-run orchestrator
  → durable RunRecord transition
  → ContextCompiler / PromptPlan
  → ResponsesAdapter or ChatCompletionsAdapter
  → validated tool call
  → external confirmation policy
  → persist redacted intent
  → FirefoxGateway / content script
  → target-specific verification
  → persist result and usage
  → next compiled request or final message
```

Every event, message, prompt usage record, and run plan carries a run ID where applicable and a monotonic sequence. Only one run may be active globally. Settings and workspace mutations are rejected while it is active.

## Durable execution

`src/persistence/repository.ts` owns one typed IndexedDB database. A fresh installation creates the first workspace and conversation in one transaction. The incompatible `firefox-agent` v0.1 database is deleted; there is no legacy data migration.

Runs transition through `planning`, `awaiting_confirmation`, `executing`, `responding`, and `completed`, with terminal `failed`, `cancelled`, and `interrupted` states. The orchestrator persists action intent before calling Firefox and persists success, failure, denial, or `unverified` afterward. On initialization all unfinished runs become `interrupted`; mutating actions are never replayed.

An `AbortController` covers the provider stream, pending confirmation, and every awaited browser operation; wrappers stop awaiting APIs that ignore `AbortSignal`, and in-flight content-script work receives a `cancel_operation` message. Stop is run-scoped, safe before and after start, and an already-dispatched mutation is recorded `unverified` rather than silently completed or retried. Late provider results cannot resurrect a cancelled run. Operational ceilings are 12 provider turns, 25 browser actions, five minutes per run, and 15 seconds per local wait.

## Context compilation

Providers receive only `PromptCompilation`; they do not construct conversation context. `ContextCompiler` orders the stable instructions and tool schemas before all dynamic material, then plans:

1. stable instructions and schemas;
2. active run state and active-tab metadata;
3. compacted checkpoint, if any;
4. locally ranked workspace notes;
5. up to six recent user/assistant pairs;
6. the current request;
7. current-run tool results and explicit page reads.

Initial context has the user request and active-tab metadata only. Page text enters context solely through `read_page`; metadata for other tabs enters through `list_tabs`.

Each `ContextSegment` has a stable content hash, token estimate, priority, and required flag. Required material must fit the hard limit. Optional page excerpts, chatter, notes, and history are admitted only within the soft limit. Chat history can be converted into a strict provider-generated compacted checkpoint; Responses endpoints can use native compaction when their connection test proved the request option is accepted. There is no automatic provider truncation.

The sidebar retains complete local chat independently of provider context. Completed page-backed runs also create deterministic, editable capsules containing request/outcome text and source references; raw page bodies, tool payloads, and form values are excluded.

Visible text emitted by intermediate provider/tool turns is stored separately from conversation context and rendered as a collapsible chat trace. Consecutive turns render as one thinking block; a new block starts only after a turn that dispatched a browser mutation, tracked via the persisted `actionsStarted` field. Encrypted or otherwise opaque provider reasoning items remain opaque. Starting a new chat atomically removes the current workspace's messages, notes, runs, usage, actions, prompt plans, and visible turn traces, then creates a fresh conversation while preserving settings.

## Provider profiles

Local settings contain named provider/key profiles and an active ID. `provider` is a derived compatibility projection. Schema migration preserves the legacy single-provider key/model; duplicate IDs and dangling selections are rejected. Editing a model updates only its active profile. Switching is idle-only and explicit, with no key rotation or cross-provider fallback. Credentials are stored locally without encryption and never included in model context. API requests reject redirects and omit ambient cookies.

## Stable provider prefix

`CORE_INSTRUCTIONS` and the 15 definitions in `src/tools/definitions.ts` are deterministic and versioned. Their exact hashes and reviewed token counts live in `src/test/fixtures/stable-budget.json`. Tests fail on byte changes and on unreviewed growth above 10%.

For Responses requests, the developer block is first, followed by dynamic messages and stateless output-item chaining with `store: false`. Function outputs retain their `call_id`; unknown reasoning and compaction items are preserved opaquely. When accepted, a single explicit cache breakpoint follows the stable developer block, and the cache key is derived from prompt version, tool-schema version, protocol, and model. Page data always follows that breakpoint.

Tool wire schemas use `strict: false` because optional/defaulted arguments are validated locally. Both adapters use the policy's actual output reserve. Repeated successful reads of the same page slice are replaced with a superseded marker in the transient trace; other queries, pages, and pagination slices remain intact. Multiline history is encoded as JSONL so embedded role-like text cannot split messages.

Chat Completions requests use the same stable-first ordering, streamed usage, and sequential tool calls. Compaction uses the configured endpoint itself and a bounded structured context.

Actual input, cached input, cache-write, output, and reasoning tokens are normalized when reported. Otherwise cached local estimates are used. Exact server counting is called only close to the soft limit.

## Page index and handles

The content script builds visible semantic blocks, excludes live form/editable values even from ancestor text, deduplicates passages, and splits long blocks instead of dropping them. Navigation regions are down-ranked rather than removed; dialogs remain readable. Text and controls share a query-ranked, serialized-JSON token budget. `text`/`controls` modes avoid irrelevant payloads. Cursors fingerprint the query, scope, and observed contents; every control remains reachable through pagination. Too-small budgets fail explicitly rather than returning truncated JSON. There is no snapshot cache that can hide property-only state changes.

`list_frames` uses a fixed extension-owned discovery function to obtain readable frame IDs. `read_page` and `wait_for` route by frame ID. Open shadow roots are traversed and observed. Handles are stored in a `WeakMap`-backed registry and bound to `{tabId, frameId, revision, id}`, with document-unique IDs. Resolution always checks connectivity and semantic identity (including accessible name, role, destination, and form action), even before mutation delivery. Unrelated DOM churn does not invalidate an unchanged target; recycled targets produce `STALE_HANDLE` and are never replaced automatically.

Interactions scroll, check visibility/disabled/occlusion, and re-resolve after scroll and focus. Native setters and activation events run site handlers; postconditions are checked after a short settling delay. Ambiguous or disabled options fail, checkbox updates are idempotent, and submit uses only valid submitters. Clicks/submissions remain `unverified` unless navigation or target accessibility state confirms a change. Removal alone is not success. Never replay an unverified action automatically.

## Trust and privacy boundaries

Page content and tool results are untrusted data under the stable developer instruction. Only HTTP(S) URLs are accepted; privileged, file, data, JavaScript, and extension URLs are rejected before Firefox is called.

The content script exposes labels, roles, non-sensitive state, and explicit page excerpts. It never includes existing text-field values. Password, OTP, verification-code, and payment-field descriptors are marked sensitive. Action values and provider secrets are redacted before persistence.

The manifest has only `storage`, `tabs`, and `scripting`, plus optional `<all_urls>` access requested during onboarding. There is no remote code or web-accessible extension resource.

## Verification

Vitest covers compiler ordering and limits, stable-prefix regression, both provider formats, SSE parsing, usage normalization, cache behavior, strict URLs, policy modes, action redaction, stale handles, atomic bootstrap, and restart interruption. A reconstructed v0.1 payload fixture enforces at least 50% lower median raw input under the reviewed v1 ceilings.

The production pipeline additionally runs strict TypeScript, ESLint, Prettier, coverage thresholds, minified Vite builds without source maps, `web-ext lint`, package inspection, production dependency audit, and Selenium tests that install the exact generated Firefox ZIP for profile persistence. The production content bundle is also executed against a local Firefox DOM fixture with a stubbed message transport, testing pagination, privacy, shadow labels, stale links, disabled/covered controls, cancelled clicks, native setters, and submission semantics.
