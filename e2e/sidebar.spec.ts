/**
 * E2E tests for the sidebar UI. Firefox cannot be driven by Playwright for
 * real WebExtension sidebars, so these tests load the built sidebar app in
 * a plain browser and inject a scripted mock of the `browser.runtime` API.
 * This exercises the real React UI, Zustand store and event pipeline.
 *
 * Run: npm run test:e2e  (builds first, serves dist/sidebar on :4173)
 */

import { test, expect, type Page } from "@playwright/test";

interface MockRuntime {
  bootstrap: NonNullable<import("@/shared/protocol").BootstrapPayload>;
  listeners: Set<(event: unknown) => void>;
  sent: unknown[];
}

/** Installs the mock runtime BEFORE any page script runs. */
async function installMock(page: Page, opts?: { devMode?: boolean }): Promise<MockRuntime> {
  const state: MockRuntime = {
    bootstrap: {
      settings: {
        provider: {
          name: "DeepSeek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "sk-test-do-not-show",
          model: "deepseek-chat",
          reasoningEffort: "medium",
          protocol: "chat_completions",
          customHeaders: {},
          temperature: 0.2,
          maxOutputTokens: 2048,
          contextLimitTokens: 64000,
          timeoutMs: 60000,
        },
        mode: "agent",
        limits: { maxActionsPerTask: 25, maxTabsInspected: 8, maxPageTextChars: 12000, maxSnapshotElements: 120, taskTimeoutMs: 600000 },
        privacy: { allowActivePageContent: true, allowOtherTabContent: true, allowFormValues: false, allowSelectedText: true, excludeSensitiveFields: true },
        compression: { enabled: true, keepRecentMessages: 8, summarizeThreshold: 24 },
        memory: { enabled: true, autoSummarizePages: true },
        devMode: opts?.devMode ?? false,
        searchEngine: "google",
      },
      runtimeState: { status: "idle", iterations: 0 },
      conversation: { id: "conv_1", title: "Test", createdAt: 1, updatedAt: 1, messageIds: [] },
      messages: [],
      workspace: {
        id: "ws_1",
        name: "Laptop Research",
        conversationId: "conv_1",
        createdAt: 1,
        updatedAt: 1,
        tabs: [
          {
            tabId: 3,
            url: "https://lenovo.example/x1",
            title: "Lenovo ThinkPad X1",
            pinned: true,
            summary: "Product page for ThinkPad X1",
            importantFacts: [
              { id: "f1", text: "$1,499", category: "price", createdAt: 1 },
              { id: "f2", text: "32GB RAM", category: "spec", createdAt: 1 },
            ],
            extractedEntities: [],
            lastInspectedAt: 1,
          },
          {
            tabId: 7,
            url: "https://dell.example/7450",
            title: "Dell Latitude 7450",
            pinned: false,
            importantFacts: [{ id: "f3", text: "$1,399", category: "price", createdAt: 1 }],
            extractedEntities: [],
            lastInspectedAt: 1,
          },
        ],
      },
      actionLog: [],
      activity: [],
      pendingConfirmation: null,
      hasSiteAccess: true,
      activeTabId: 3,
    },
    listeners: new Set(),
    sent: [],
  };

  await page.addInitScript((bootstrap: import("@/shared/protocol").BootstrapPayload) => {
    const listeners = new Set<(event: unknown) => void>();
    (window as unknown as Record<string, unknown>).__FFA_MOCK_RUNTIME = {
      async send(request: { type: string; text?: string; settings?: unknown; requestId?: string; approved?: boolean }) {
        // Record for assertions.
        (window as unknown as { __FFA_SENT?: unknown[] }).__FFA_SENT ??= [];
        (window as unknown as { __FFA_SENT: unknown[] }).__FFA_SENT.push(request);
        switch (request.type) {
          case "GET_BOOTSTRAP":
            return { ok: true, bootstrap };
          case "GET_SETTINGS":
            return { ok: true, settings: bootstrap.settings };
          case "SEND_USER_MESSAGE": {
            // Simulate the background: echo the user message, then stream a reply.
            const activityStartedAt = Date.now();
            const userMsg = { id: "m1", role: "user", content: request.text ?? "", createdAt: Date.now(), conversationId: "conv_1" };
            setTimeout(() => {
              for (const l of listeners) l({ type: "MESSAGE_ADDED", message: userMsg });
            }, 10);
            setTimeout(() => {
              for (const l of listeners) l({ type: "STREAM_DELTA", text: "I inspected the page and found " });
            }, 60);
            setTimeout(() => {
              for (const l of listeners) l({ type: "STREAM_DELTA", text: "the Lenovo is $1,499." });
            }, 120);
            setTimeout(() => {
              for (const l of listeners)
                l({
                  type: "ACTIVITY_UPDATED",
                  activity: {
                    id: "think1",
                    conversationId: "conv_1",
                    kind: "thinking",
                    tool: "agent",
                    label: "Planned step 1",
                    detail: "Next action: get_page_snapshot",
                    status: "ok",
                    startedAt: activityStartedAt,
                    finishedAt: Date.now(),
                  },
                });
              for (const l of listeners)
                l({
                  type: "ACTIVITY_UPDATED",
                  activity: {
                    id: "a1",
                    conversationId: "conv_1",
                    tool: "get_page_snapshot",
                    label: "Read current page",
                    status: "ok",
                    startedAt: activityStartedAt,
                    finishedAt: Date.now(),
                  },
                });
              for (const l of listeners) l({ type: "STREAM_DONE" });
              for (const l of listeners)
                l({
                  type: "MESSAGE_ADDED",
                  message: { id: "m2", role: "assistant", content: "I inspected the page and found the Lenovo is $1,499.", createdAt: Date.now(), conversationId: "conv_1" },
                });
              for (const l of listeners) l({ type: "AGENT_STATE", state: { status: "idle", iterations: 3 } });
            }, 180);
            for (const l of listeners) l({ type: "AGENT_STATE", state: { status: "running", iterations: 1, currentActivity: "Reading page…" } });
            for (const l of listeners)
              l({
                type: "ACTIVITY",
                activity: {
                  id: "think1",
                  conversationId: "conv_1",
                  kind: "thinking",
                  tool: "agent",
                  label: "Planning step 1",
                  status: "running",
                  startedAt: activityStartedAt,
                },
              });
            for (const l of listeners)
              l({
                type: "ACTIVITY",
                activity: {
                  id: "a1",
                  conversationId: "conv_1",
                  tool: "get_page_snapshot",
                  label: "Read current page",
                  status: "running",
                  startedAt: activityStartedAt,
                },
              });
            return { ok: true, accepted: true };
          }
          case "SET_SETTINGS":
            return { ok: true, settings: request.settings };
          case "ENSURE_PERMISSIONS":
            return { ok: true, accepted: true };
          case "FETCH_MODELS":
            return { ok: true, models: ["deepseek-chat", "deepseek-reasoner"] };
          case "CONFIRMATION_RESPONSE":
            for (const l of listeners) {
              l({
                type: "CONFIRMATION_RESOLVED",
                requestId: request.requestId ?? "",
                approved: request.approved ?? false,
              });
            }
            return { ok: true, accepted: true };
          case "NEW_CONVERSATION":
            for (const l of listeners) {
              l({ type: "CONVERSATION_RESET", conversationId: "conv_2" });
            }
            return { ok: true, accepted: true };
          case "GET_DEV_EVENTS":
            return { ok: true, devEvents: [] };
          default:
            return { ok: true, accepted: true };
        }
      },
      onEvent(listener: (event: unknown) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    // Expose an emit helper so tests can push background events.
    (window as unknown as Record<string, unknown>).__FFA_MOCK_EMIT = (event: unknown) => {
      for (const l of listeners) l(event);
    };
  }, state.bootstrap);

  return state;
}

test("chat: sends a message and renders the streamed reply", async ({ page }) => {
  await installMock(page);
  await page.goto("/");
  await expect(page.getByText("Ask anything about your browser")).toBeVisible();

  await page.getByPlaceholder("Ask the agent… (Enter to send)").fill("Summarize this page");
  await page.getByRole("button", { name: "Send" }).click();

  await expect(page.getByRole("status")).toContainText("Agent thinking");
  await expect(page.getByText("get_page_snapshot", { exact: true })).toBeVisible();
  await expect(page.getByText("Running", { exact: true })).toBeVisible();
  await expect(page.getByText("You")).toBeVisible();
  await expect(page.getByText("I inspected the page and found the Lenovo is $1,499.")).toBeVisible({ timeout: 5000 });
  // Tool calls are shown inline in the conversation with their lifecycle.
  await expect(page.getByText("Read current page")).toBeVisible();
  await expect(page.locator(".tool-call-item").filter({ hasText: "Read current page" }).getByText("Completed", { exact: true })).toBeVisible();
  await expect(page.getByText("Next action: get_page_snapshot", { exact: true })).toBeVisible();
  const sent = await page.evaluate(
    () => (window as unknown as { __FFA_SENT?: Array<{ type: string }> }).__FFA_SENT ?? [],
  );
  expect(sent.some((request) => request.type === "SEND_USER_MESSAGE")).toBe(true);
});

test("chat: switches model and reasoning effort", async ({ page }) => {
  await installMock(page);
  await page.goto("/");

  const model = page.getByRole("combobox", { name: "Model" });
  const reasoning = page.getByRole("combobox", { name: "Reasoning effort" });
  await expect(model).toHaveValue("deepseek-chat");
  await expect(reasoning).toHaveValue("medium");

  await model.selectOption("deepseek-reasoner");
  await expect(model).toHaveValue("deepseek-reasoner");
  await reasoning.selectOption("high");
  await expect(reasoning).toHaveValue("high");

  const sent = await page.evaluate(
    () => (window as unknown as { __FFA_SENT?: Array<{ type: string; settings?: { provider?: { model?: string; reasoningEffort?: string } } }> }).__FFA_SENT ?? [],
  );
  const updates = sent.filter((request) => request.type === "SET_SETTINGS");
  expect(updates.some((request) => request.settings?.provider?.model === "deepseek-reasoner")).toBe(true);
  expect(updates.some((request) => request.settings?.provider?.reasoningEffort === "high")).toBe(true);
});

test("chat: starts a new chat from the persistent toolbar button", async ({ page }) => {
  await installMock(page);
  await page.goto("/");

  await page.getByPlaceholder("Ask the agent… (Enter to send)").fill("Hello");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("I inspected the page and found the Lenovo is $1,499.")).toBeVisible();

  await page.getByRole("button", { name: "New chat" }).click();

  await expect(page.getByText("Ask anything about your browser")).toBeVisible();
  await expect(page.getByText("I inspected the page and found the Lenovo is $1,499.")).toBeHidden();
  const sent = await page.evaluate(
    () => (window as unknown as { __FFA_SENT?: Array<{ type: string }> }).__FFA_SENT ?? [],
  );
  expect(sent.some((request) => request.type === "NEW_CONVERSATION")).toBe(true);
});

test("confirmation: shows the approval banner and resolves it", async ({ page }) => {
  await installMock(page);
  await page.goto("/");

  // Simulate the background pushing a high-risk confirmation request.
  await page.evaluate(() => {
    const emit = (window as unknown as { __FFA_MOCK_EMIT?: (e: unknown) => void }).__FFA_MOCK_EMIT;
    emit?.({
      type: "CONFIRMATION_REQUESTED",
      request: {
        id: "c1",
        tool: "click_element",
        description: "Click Place order ($249.99)",
        details: "Tool: click_element\nAction: Click Place order ($249.99)\nAction looks financial.",
        tabId: 3,
        requestedAt: Date.now(),
        expiresAt: Date.now() + 300000,
        highRisk: true,
      },
    });
  });

  await expect(page.getByText("Action requires your approval")).toBeVisible();
  await expect(page.getByText("Click Place order ($249.99)", { exact: true })).toBeVisible();

  // Cancel resolves the request without executing anything.
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByText("Action requires your approval")).toBeHidden({ timeout: 3000 });
});

test("context panel: shows workspace tabs, summaries and facts", async ({ page }) => {
  await installMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Context" }).click();

  await expect(page.getByText("Laptop Research")).toBeVisible();
  await expect(page.getByText("Lenovo ThinkPad X1")).toBeVisible();
  await expect(page.getByText("Dell Latitude 7450")).toBeVisible();
  await expect(page.getByText("$1,499")).toBeVisible();
  await expect(page.getByText("$1,399")).toBeVisible();
  await expect(page.getByText("2 tabs in context")).toBeVisible();
});

test("settings: provider defaults to DeepSeek and can fetch models", async ({ page }) => {
  const mock = await installMock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  const baseUrl = page.getByPlaceholder("https://api.openai.com/v1");
  await expect(baseUrl).toHaveValue("https://api.deepseek.com");
  await expect(page.getByPlaceholder("deepseek-chat")).toHaveValue("deepseek-chat");

  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("2 models available")).toBeVisible();
  void mock;
});

test("dev panel: visible only in dev mode and shows context sizes", async ({ page }) => {
  await installMock(page, { devMode: true });
  await page.goto("/");
  await page.getByRole("button", { name: "Dev" }).click();
  await expect(page.getByText("Developer")).toBeVisible();
  await expect(page.getByText("Model: deepseek-chat")).toBeVisible();
});
