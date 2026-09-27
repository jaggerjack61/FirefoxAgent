import { abortable, abortableDelay } from "@/shared/abort";
import { createId } from "@/shared/token";
import {
  contentCommandSchema,
  elementHandleSchema,
  pageSnapshotSchema,
  type ToolName,
} from "@/shared/schema";
import { assertWebUrl, type TargetDescriptor } from "@/security/policy";

const CONTENT_SCRIPT_ID = "browseragent-content-v1";
const WEB_MATCHES = ["http://*/*", "https://*/*"];
/** Bounded wait after a navigation so the next read sees the new document, not the old one. */
const NAVIGATION_TIMEOUT_MS = 10_000;
/** A navigation that never reports "loading" (same-document, no history entry) settles after this. */
const NAVIGATION_GRACE_MS = 400;
const NAVIGATION_POLL_MS = 100;

export interface ToolExecution {
  output: Record<string, unknown>;
  source?: { tabId: number; url: string; title: string; capturedAt: number };
}

export class FirefoxGateway {
  async hasSiteAccess(): Promise<boolean> {
    return browser.permissions.contains({ origins: ["<all_urls>"] });
  }

  async requestSiteAccess(): Promise<boolean> {
    const granted = await browser.permissions.request({ origins: ["<all_urls>"] });
    if (granted) await this.registerContentScript();
    return granted;
  }

  async registerContentScript(): Promise<void> {
    if (!(await this.hasSiteAccess())) return;
    const existing = await browser.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    if (existing.length > 0) return;
    await browser.scripting.registerContentScripts([
      {
        id: CONTENT_SCRIPT_ID,
        matches: WEB_MATCHES,
        js: ["content/index.js"],
        allFrames: true,
        runAt: "document_idle",
        persistAcrossSessions: true,
      },
    ]);
  }

  async activeTab(): Promise<{ id: number; title: string; url: string } | undefined> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id === undefined || !tab.url) return undefined;
    return { id: tab.id, title: tab.title ?? "", url: tab.url };
  }

  async describe(handleValue: unknown, signal?: AbortSignal): Promise<TargetDescriptor> {
    const handle = elementHandleSchema.parse(handleValue);
    return this.sendContent<TargetDescriptor>(
      handle.tabId,
      handle.frameId,
      {
        type: "describe",
        handle,
      },
      signal,
    );
  }

  async execute(
    name: ToolName,
    input: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolExecution> {
    signal?.throwIfAborted();
    switch (name) {
      case "list_tabs": {
        const query = String(input.query ?? "").toLocaleLowerCase();
        const limit = Number(input.limit ?? 30);
        const tabs = (await browser.tabs.query({}))
          .filter((tab) => tab.id !== undefined && tab.url && isWebUrl(tab.url))
          .filter(
            (tab) => !query || `${tab.title ?? ""} ${tab.url ?? ""}`.toLocaleLowerCase().includes(query),
          )
          .slice(0, limit)
          .map((tab) => ({
            id: tab.id,
            title: tab.title ?? "",
            url: tab.url,
            active: tab.active,
            windowId: tab.windowId,
          }));
        return { output: { tabs } };
      }
      case "open_tab": {
        const url = assertWebUrl(String(input.url));
        const tab = await browser.tabs.create({ url, active: Boolean(input.active ?? true) });
        if (tab.id === undefined) return { output: { url, opened: true } };
        return { output: { opened: true, ...(await this.settleNavigation(tab.id, signal)) } };
      }
      case "activate_tab": {
        const tabId = Number(input.tabId);
        const tab = await browser.tabs.update(tabId, { active: true });
        signal?.throwIfAborted();
        if (tab.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
        return { output: { tabId, activated: true } };
      }
      case "close_tab": {
        const tabId = Number(input.tabId);
        await browser.tabs.remove(tabId);
        return { output: { tabId, closed: true } };
      }
      case "navigate": {
        const tabId = Number(input.tabId);
        const url = assertWebUrl(String(input.url));
        await browser.tabs.update(tabId, { url });
        return { output: { navigated: true, ...(await this.settleNavigation(tabId, signal)) } };
      }
      case "go_back": {
        const tabId = Number(input.tabId);
        await browser.tabs.goBack(tabId);
        return { output: { navigatedBack: true, ...(await this.settleNavigation(tabId, signal)) } };
      }
      case "reload": {
        const tabId = Number(input.tabId);
        await browser.tabs.reload(tabId);
        return { output: { reloaded: true, ...(await this.settleNavigation(tabId, signal)) } };
      }
      case "list_frames": {
        const tabId = Number(input.tabId);
        await this.webTab(tabId);
        signal?.throwIfAborted();
        const results = await browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          // Firefox returns serialized function results; the v120 typings incorrectly allow only void.
          func: (() => ({ url: location.href, title: document.title })) as () => void,
        });
        return { output: { frames: results.map((entry) => ({ frameId: entry.frameId, ...entry.result })) } };
      }
      case "read_page": {
        const tabId = Number(input.tabId);
        const tab = await this.webTab(tabId);
        const command = contentCommandSchema.parse({
          type: "snapshot",
          tabId,
          frameId: input.frameId ?? 0,
          mode: input.mode ?? "all",
          query: input.query ?? "",
          cursor: input.cursor ?? null,
          maxTokens: input.maxTokens,
        });
        const snapshot = pageSnapshotSchema.parse(
          await this.sendContent(tabId, Number(input.frameId ?? 0), command, signal),
        );
        return {
          output: snapshot,
          source: {
            tabId,
            url: snapshot.url,
            title: snapshot.title || (tab.title ?? ""),
            capturedAt: Date.now(),
          },
        };
      }
      case "wait_for": {
        const tabId = Number(input.tabId);
        await this.webTab(tabId);
        const output = await this.sendContent<Record<string, unknown>>(
          tabId,
          Number(input.frameId ?? 0),
          contentCommandSchema.parse({
            type: "wait",
            condition: input.condition,
            timeoutMs: input.timeoutMs,
          }),
          signal,
        );
        return { output };
      }
      case "search_history": {
        const maxResults = Number(input.maxResults ?? 20);
        const search: { text: string; maxResults: number; startTime?: number } = {
          text: String(input.query ?? ""),
          maxResults,
        };
        if (input.withinDays) search.startTime = Date.now() - Number(input.withinDays) * 86_400_000;
        const items = await browser.history.search(search);
        // Non-HTTP(S) history entries (file://, privileged pages) never enter model context.
        const results = items
          .filter((item) => item.url !== undefined && isWebUrl(item.url))
          .slice(0, maxResults)
          .map((item) => ({
            url: item.url ?? "",
            title: item.title ?? "",
            lastVisitTime: item.lastVisitTime ?? 0,
            visitCount: item.visitCount ?? 0,
          }));
        return { output: { results } };
      }
      case "search_bookmarks": {
        const maxResults = Number(input.maxResults ?? 20);
        const nodes = (await browser.bookmarks.search({ query: String(input.query ?? "") }))
          .filter((node) => node.url !== undefined && isWebUrl(node.url))
          .slice(0, maxResults);
        const parentIds = [...new Set(nodes.flatMap((node) => (node.parentId ? [node.parentId] : [])))];
        const parents = parentIds.length > 0 ? await browser.bookmarks.get(parentIds) : [];
        const folders = new Map(parents.map((parent) => [parent.id, parent.title] as const));
        return {
          output: {
            bookmarks: nodes.map((node) => ({
              title: node.title,
              url: node.url ?? "",
              folder: node.parentId !== undefined ? (folders.get(node.parentId) ?? "") : "",
            })),
          },
        };
      }
      case "click":
      case "fill":
      case "select":
      case "set_checked":
      case "submit": {
        const handle = elementHandleSchema.parse(input.handle);
        await this.webTab(handle.tabId);
        const value = name === "set_checked" ? input.checked : input.value;
        const output = await this.sendContent<Record<string, unknown>>(
          handle.tabId,
          handle.frameId,
          contentCommandSchema.parse({
            type: "act",
            action: name,
            handle,
            value,
          }),
          signal,
        );
        return { output };
      }
    }
  }

  /**
   * Wait until a just-started navigation finishes loading and report where the tab landed.
   * This saves the model a wait_for/list_tabs turn and keeps read_page off a half-loaded or
   * about:blank document. A timeout is reported, never treated as an error: the navigation
   * itself was dispatched.
   */
  private async settleNavigation(
    tabId: number,
    signal?: AbortSignal,
  ): Promise<{ tabId: number; url?: string; title?: string; loaded: boolean }> {
    const started = Date.now();
    let sawLoading = false;
    let tab: browser.tabs.Tab | undefined;
    while (Date.now() - started < NAVIGATION_TIMEOUT_MS) {
      try {
        tab = await abortable(signal, () => browser.tabs.get(tabId));
      } catch (error) {
        if (signal?.aborted) throw error;
        return { tabId, loaded: false }; // Closed or replaced while loading.
      }
      if (tab.status === "loading") sawLoading = true;
      else if (sawLoading || Date.now() - started >= NAVIGATION_GRACE_MS) break;
      await abortableDelay(NAVIGATION_POLL_MS, signal);
    }
    // Tool results are tightly budgeted: a clipped URL would be wrong if reused, so omit long ones.
    return {
      tabId,
      ...(tab?.url && tab.url.length <= 200 ? { url: tab.url } : {}),
      ...(tab?.title ? { title: tab.title.slice(0, 100) } : {}),
      loaded: tab?.status !== "loading",
    };
  }

  private async webTab(tabId: number): Promise<browser.tabs.Tab> {
    const tab = await browser.tabs.get(tabId);
    if (!tab.url || !isWebUrl(tab.url)) throw new Error("The tab is not an HTTP(S) page");
    return tab;
  }

  private async sendContent<T>(
    tabId: number,
    frameId: number,
    command: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    signal?.throwIfAborted();
    const operationId =
      signal && ["act", "wait"].includes(String(command.type)) ? createId("operation") : undefined;
    const payload = operationId ? { ...command, operationId } : command;
    let sent = false;
    const cancel = () => {
      if (operationId && sent)
        void browser.tabs
          .sendMessage(tabId, { type: "cancel_operation", operationId }, { frameId })
          .catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const send = () =>
      abortable(signal, () => {
        sent = true;
        return browser.tabs.sendMessage(tabId, payload, { frameId }) as Promise<T>;
      });
    try {
      return await send();
    } catch (error) {
      // Only retry when no content script received the command. A handler can
      // reject after performing a side effect, so other failures must not replay it.
      if (
        signal?.aborted ||
        !(error instanceof Error) ||
        error.message !== "Could not establish connection. Receiving end does not exist."
      ) {
        throw error;
      }
      await abortable(signal, () =>
        browser.scripting.executeScript({
          target: { tabId, allFrames: true },
          files: ["content/index.js"],
        }),
      );
      return await send();
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }
}

function isWebUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
