/**
 * Real BrowserGateway implementation on top of Firefox WebExtension APIs.
 *
 * Responsibilities:
 *  - tab/window operations via browser.tabs / browser.sessions
 *  - content-script lifecycle (dynamic registration after optional host
 *    permission is granted)
 *  - per-frame messaging with element-id routing and stale-element recovery
 *  - snapshot caching + invalidation on URL/mutation changes
 *  - compact observation formatting (never the full DOM)
 */

import type { BrowserGateway, ElementDescriptor, InteractionResult, NavigateResult, OpenTabOptions, TabMeta, UndoableAction } from "@/shared/browserGateway";
import type { ContentRequest, ContentResponse, PageSnapshot, SnapshotRequestOptions } from "@/shared/contentProtocol";
import { ToolError } from "@/shared/errors";
import { elementIdForFrame, splitElementId } from "@/shared/contentProtocol";
import { findBestSemanticMatch, identityOfElement, type MatchCandidate } from "@/shared/semanticMatch";
import { sleep } from "@/shared/id";

const CONTENT_SCRIPT_ID = "ffa-core";
const ALL_URLS = ["<all_urls>"];
const NETWORK_IDLE_MS = 500;
const MAX_NETWORK_SETTLE_MS = 5_000;

interface SnapshotCacheEntry {
  snapshot: PageSnapshot;
  url: string;
  at: number;
  options: NormalizedSnapshotOptions;
}

interface NormalizedSnapshotOptions {
  maxTextChars: number;
  maxElements: number;
  maxLinks: number;
  includeValues: boolean;
  includeFrames: boolean;
}

const DEFAULT_SNAPSHOT_OPTIONS: NormalizedSnapshotOptions = {
  maxTextChars: 12_000,
  maxElements: 120,
  maxLinks: 200,
  includeValues: false,
  includeFrames: true,
};

export class FirefoxGateway implements BrowserGateway {
  /** A tab can have several cached projections with different data limits. */
  private readonly snapshots = new Map<number, SnapshotCacheEntry[]>();
  private readonly undoStack: UndoableAction[] = [];
  private readonly pendingApiRequests = new Map<number, Set<string>>();
  private readonly lastApiActivity = new Map<number, number>();
  private readonly apiBusySince = new Map<number, number>();
  private readonly documentCompletedAt = new Map<number, number>();
  private contentScriptsRegistered = false;

  constructor() {
    browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.url || changeInfo.status === "loading") this.invalidate(tabId);
      if (changeInfo.status === "loading") this.markNavigationStarted(tabId);
      if (changeInfo.status === "complete") this.documentCompletedAt.set(tabId, Date.now());
    });
    browser.tabs.onRemoved?.addListener((tabId) => this.clearReadinessState(tabId));
    this.installApiRequestTracking();
  }

  // -------------------------------------------------------------------------
  // Tabs
  // -------------------------------------------------------------------------

  async listTabs(): Promise<TabMeta[]> {
    const tabs = await browser.tabs.query({});
    return tabs
      .filter((t) => t.id !== undefined)
      .map((t) => this.withReadiness(toTabMeta(t)));
  }

  async getActiveTab(): Promise<TabMeta | null> {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return null;
    return this.withReadiness(toTabMeta(tab));
  }

  async getTab(tabId: number): Promise<TabMeta | null> {
    try {
      const t = await browser.tabs.get(tabId);
      return this.withReadiness(toTabMeta(t));
    } catch {
      return null;
    }
  }

  async switchTab(tabId: number): Promise<void> {
    await this.withTab(tabId, () => browser.tabs.update(tabId, { active: true }));
  }

  async openTab(url: string, opts: OpenTabOptions = {}): Promise<TabMeta> {
    const tab = await browser.tabs.create({ url, active: opts.active ?? !opts.background, windowId: opts.windowId, index: opts.index });
    if (!tab.id) throw new ToolError("INTERNAL_ERROR", "Failed to create tab");
    this.markNavigationStarted(tab.id);
    const canProceed = await this.waitForTabReady(tab.id, 15_000);
    const meta = (await this.getTab(tab.id)) ?? toTabMeta(tab);
    return { ...meta, ready: meta.ready ?? canProceed };
  }

  async closeTab(tabId: number): Promise<void> {
    const tab = await this.getTab(tabId);
    if (tab) this.recordUndoable({ kind: "close_tab", tabId, sessionId: "" });
    try {
      await browser.tabs.remove(tabId);
    } catch {
      throw new ToolError("TAB_CLOSED", `Tab ${tabId} is already closed.`);
    }
    this.invalidate(tabId);
    this.clearReadinessState(tabId);
  }

  async reloadTab(tabId: number): Promise<void> {
    this.markNavigationStarted(tabId);
    await this.withTab(tabId, () => browser.tabs.reload(tabId));
    this.invalidate(tabId);
    await this.waitForTabReady(tabId, 15_000);
  }

  async duplicateTab(tabId: number): Promise<TabMeta> {
    const tab = await browser.tabs.duplicate(tabId);
    if (!tab.id) throw new ToolError("INTERNAL_ERROR", "Failed to duplicate tab");
    this.markNavigationStarted(tab.id);
    const canProceed = await this.waitForTabReady(tab.id, 15_000);
    const meta = (await this.getTab(tab.id)) ?? toTabMeta(tab);
    return { ...meta, ready: meta.ready ?? canProceed };
  }

  async goBack(tabId: number): Promise<void> {
    this.markNavigationStarted(tabId);
    await this.withTab(tabId, () => browser.tabs.goBack(tabId));
    this.invalidate(tabId);
    await this.waitForTabReady(tabId, 15_000);
  }

  async goForward(tabId: number): Promise<void> {
    this.markNavigationStarted(tabId);
    await this.withTab(tabId, () => browser.tabs.goForward(tabId));
    this.invalidate(tabId);
    await this.waitForTabReady(tabId, 15_000);
  }

  async restoreClosedTab(sessionId: string): Promise<TabMeta | null> {
    const sessions = await browser.sessions.getRecentlyClosed();
    const target = sessionId
      ? sessions.find((s) => s.tab?.sessionId === sessionId)
      : sessions.find((s) => s.tab);
    if (!target?.tab) return null;
    const restored = await browser.sessions.restore(target.tab.sessionId);
    const tab = restored.tab;
    if (!tab?.id) return null;
    return this.withReadiness(toTabMeta(tab));
  }

  // -------------------------------------------------------------------------
  // Navigation
  // -------------------------------------------------------------------------

  async navigate(tabId: number, url: string, opts: { timeoutMs?: number } = {}): Promise<NavigateResult> {
    this.markNavigationStarted(tabId);
    await this.withTab(tabId, () => browser.tabs.update(tabId, { url }));
    this.invalidate(tabId);
    const timeoutMs = opts.timeoutMs ?? 15_000;
    const canProceed = await this.waitForTabReady(tabId, timeoutMs);
    const meta = await this.getTab(tabId);
    const loaded = meta?.status === "complete";
    const networkIdle = meta?.ready ?? false;
    const urlAfter = meta?.url ?? url;
    let newElements: NavigateResult["newElements"] = [];
    if (canProceed && loaded) try {
      const snapshot = await this.getSnapshot(tabId, { maxElements: 60, maxTextChars: 0, maxLinks: 0, includeFrames: true });
      newElements = compactSnapshotElements(snapshot, 60);
    } catch {
      // Restricted/internal pages can still be navigated to; they simply have
      // no inspectable post-navigation snapshot.
    }
    return {
      success: true,
      observation: [
        `Navigated to ${urlAfter}${loaded ? "" : " (document is still loading)"}.`,
        loaded && !networkIdle ? "Background page API activity is continuing; proceeding with the completed document." : "",
        newElements.length ? `Current visible elements:\n${formatCompactElements(newElements)}` : "",
      ].filter(Boolean).join("\n"),
      pageChanged: true,
      newElements,
      tabId,
      url: urlAfter,
      title: meta?.title ?? "",
      finalUrl: urlAfter,
      loaded,
      networkIdle,
    };
  }

  /** Polling avoids missing a very fast `complete` event between update/listen. */
  async waitForTabReady(tabId: number, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const tab = await browser.tabs.get(tabId);
        if (tab.status === "complete") {
          if (this.isApiIdle(tabId)) return true;
          const busySince = this.apiBusySince.get(tabId) ?? this.documentCompletedAt.get(tabId) ?? Date.now();
          this.apiBusySince.set(tabId, busySince);
          // Long-polling, SSE, and continuously refreshed APIs may never be
          // fully idle. Once the document is complete, stop blocking after a
          // bounded settle window; readiness metadata remains false so the
          // agent can report that background API activity continues.
          if (Date.now() - busySince >= Math.min(timeoutMs, MAX_NETWORK_SETTLE_MS)) return true;
        }
      } catch {
        throw new ToolError("TAB_NOT_FOUND", `Tab ${tabId} no longer exists.`);
      }
      await sleep(100);
    }
    return false;
  }

  /** Tracks page fetch/XHR/beacon traffic; persistent WebSockets are intentionally excluded. */
  private installApiRequestTracking(): void {
    const requestFilter: browser.webRequest.RequestFilter = {
      urls: ALL_URLS,
      types: ["xmlhttprequest", "ping", "beacon"],
    };
    browser.webRequest?.onBeforeRequest?.addListener((details) => {
      if (details.tabId < 0) return;
      const now = Date.now();
      const pending = this.pendingApiRequests.get(details.tabId) ?? new Set<string>();
      const lastActivity = this.lastApiActivity.get(details.tabId) ?? 0;
      if (pending.size === 0 && now - lastActivity >= NETWORK_IDLE_MS) {
        this.apiBusySince.set(details.tabId, now);
      }
      pending.add(details.requestId);
      this.pendingApiRequests.set(details.tabId, pending);
      this.lastApiActivity.set(details.tabId, now);
    }, requestFilter);

    const finish = (details: { tabId: number; requestId: string }): void => {
      if (details.tabId < 0) return;
      const pending = this.pendingApiRequests.get(details.tabId);
      if (!pending?.delete(details.requestId)) return;
      if (pending.size === 0) this.pendingApiRequests.delete(details.tabId);
      this.lastApiActivity.set(details.tabId, Date.now());
    };
    browser.webRequest?.onCompleted?.addListener(finish, requestFilter);
    browser.webRequest?.onErrorOccurred?.addListener(finish, requestFilter);
  }

  private markNavigationStarted(tabId: number): void {
    const now = Date.now();
    this.pendingApiRequests.delete(tabId);
    this.documentCompletedAt.delete(tabId);
    this.lastApiActivity.set(tabId, now);
    this.apiBusySince.set(tabId, now);
  }

  private clearReadinessState(tabId: number): void {
    this.pendingApiRequests.delete(tabId);
    this.lastApiActivity.delete(tabId);
    this.apiBusySince.delete(tabId);
    this.documentCompletedAt.delete(tabId);
  }

  private isApiIdle(tabId: number, now = Date.now()): boolean {
    if ((this.pendingApiRequests.get(tabId)?.size ?? 0) > 0) return false;
    const quietSince = Math.max(this.lastApiActivity.get(tabId) ?? 0, this.documentCompletedAt.get(tabId) ?? 0);
    const idle = quietSince === 0 || now - quietSince >= NETWORK_IDLE_MS;
    if (idle) this.apiBusySince.delete(tabId);
    return idle;
  }

  private withReadiness(meta: TabMeta): TabMeta {
    return { ...meta, ready: meta.status === "complete" && this.isApiIdle(meta.id) };
  }

  // -------------------------------------------------------------------------
  // Content scripts
  // -------------------------------------------------------------------------

  async hasHostAccess(url: string): Promise<boolean> {
    try {
      // Firefox's permissions API expects match patterns, not ordinary URLs.
      // Check the optional global grant first because it covers every normal
      // page even though it is not string-equal to a site-specific pattern.
      if (await browser.permissions.contains({ origins: ALL_URLS })) return true;

      const origin = hostPermissionPattern(url);
      return origin ? await browser.permissions.contains({ origins: [origin] }) : false;
    } catch {
      return false;
    }
  }

  async ensureContentScripts(): Promise<void> {
    if (this.contentScriptsRegistered) return;
    const granted = await browser.permissions.contains({ origins: ALL_URLS });
    if (!granted) {
      throw new ToolError("PERMISSION_REQUIRED", "Site access has not been granted. Grant it from the settings panel.", {
        suggestedAction: "Ask the user to enable site access in Settings → Privacy & access.",
      });
    }
    try {
      await browser.scripting.registerContentScripts([
        {
          id: CONTENT_SCRIPT_ID,
          js: ["content/index.js"],
          matches: ALL_URLS,
          allFrames: true,
          runAt: "document_idle",
        },
      ]);
      this.contentScriptsRegistered = true;
    } catch (err) {
      // Already registered is fine (background restarts happen often).
      const msg = err instanceof Error ? err.message : String(err);
      if (/already registered|duplicate/i.test(msg)) {
        this.contentScriptsRegistered = true;
        return;
      }
      throw new ToolError("CONTENT_SCRIPT_UNAVAILABLE", `Failed to register content scripts: ${msg}`);
    }
  }

  async isContentScriptAvailable(tabId: number): Promise<boolean> {
    try {
      await browser.tabs.sendMessage(tabId, { kind: "ping" } as unknown as ContentRequest, { frameId: 0 });
      return true;
    } catch {
      return false;
    }
  }

  async sendToFrame(tabId: number, frameId: number, request: ContentRequest): Promise<ContentResponse> {
    const ready = await this.waitForTabReady(tabId);
    if (!ready) {
      throw new ToolError("NAVIGATION_TIMEOUT", `The page in tab ${tabId} is still loading or waiting for API responses.`, {
        suggestedAction: "Wait for the document and page API requests to become idle before retrying the action.",
        retryable: true,
      });
    }
    return this.sendToReadyFrame(tabId, frameId, request);
  }

  /** Sends after the caller has already established that the document is ready. */
  private async sendToReadyFrame(tabId: number, frameId: number, request: ContentRequest): Promise<ContentResponse> {
    try {
      return (await browser.tabs.sendMessage(tabId, request, { frameId })) as ContentResponse;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (/receiving end does not exist/i.test(msg)) {
        throw new ToolError("CONTENT_SCRIPT_UNAVAILABLE", `The page in tab ${tabId} cannot be inspected (script not injected or page is internal).`, {
          suggestedAction: "Reload the tab and retry.",
        });
      }
      throw new ToolError("INTERNAL_ERROR", msg);
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  invalidate(tabId: number): void {
    this.snapshots.delete(tabId);
  }

  /** Merges the top frame snapshot with iframe snapshots (frame-scoped ids). */
  async getSnapshot(tabId: number, opts: SnapshotRequestOptions = {}): Promise<PageSnapshot> {
    const ready = await this.waitForTabReady(tabId);
    if (!ready) {
      throw new ToolError("NAVIGATION_TIMEOUT", `The page in tab ${tabId} is still loading or waiting for API responses.`, {
        suggestedAction: "Wait for the document and page API requests to become idle before retrying the read.",
        retryable: true,
      });
    }
    await this.ensureContentScripts();
    const requested = normalizeSnapshotOptions(opts);
    const cachedEntries = this.snapshots.get(tabId) ?? [];
    const meta = await this.getTab(tabId);
    const cached = [...cachedEntries].reverse().find((entry) =>
      entry.url === meta?.url && snapshotSatisfies(entry.options, requested),
    );
    if (cached) return { ...projectSnapshot(cached.snapshot, requested), networkIdle: this.isApiIdle(tabId) };

    let frames: { frameId: number; url: string }[];
    try {
      frames = (await browser.webNavigation.getAllFrames({ tabId })) ?? [];
    } catch {
      frames = [];
    }
    const others = frames.filter((f) => f.frameId !== 0);

    const topResp = await this.sendToReadyFrame(tabId, 0, { kind: "get_snapshot", frameId: 0, opts: requested });
    if (!topResp.ok) throw this.toToolError(topResp);
    const merged: PageSnapshot = { ...(topResp.data as PageSnapshot) };

    // Merge iframe snapshots when privacy settings permit other-frame content.
    if (others.length && requested.includeFrames) {
      for (const frame of others.slice(0, 8)) {
        try {
          const resp = await this.sendToReadyFrame(tabId, frame.frameId, {
            kind: "get_snapshot",
            frameId: frame.frameId,
            opts: { ...requested, maxElements: Math.min(requested.maxElements, 40) },
          });
          if (!resp.ok) continue;
          const frameSnap = resp.data as PageSnapshot;
          const prefixed: PageSnapshot["elements"] = frameSnap.elements.map((e) => ({
            ...e,
            id: elementIdForFrame(frame.frameId, e.id),
          }));
          merged.elements = [...merged.elements, ...prefixed].slice(0, requested.maxElements);
          if (frameSnap.text && merged.text.length < 4_000) {
            merged.text += `\n\n[iframe ${frame.frameId}: ${frame.url}]\n${frameSnap.text.slice(0, 1_500)}`;
          }
        } catch {
          /* cross-origin frames without access are skipped */
        }
      }
    }

    const nextEntries = cachedEntries.filter((entry) => entry.url === merged.url);
    nextEntries.push({ snapshot: merged, url: merged.url, at: Date.now(), options: requested });
    this.snapshots.set(tabId, nextEntries.slice(-6));
    return { ...projectSnapshot(merged, requested), networkIdle: this.isApiIdle(tabId) };
  }

  // -------------------------------------------------------------------------
  // Interactions with stale-element recovery
  // -------------------------------------------------------------------------

  private async interact(
    tabId: number,
    elementId: string,
    build: (frameId: number, localId: string) => ContentRequest,
    opts: { settleAfterAction?: boolean } = {},
  ): Promise<InteractionResult> {
    const before = await this.getTab(tabId);
    const oldDescriptor = this.cachedElementDescriptor(tabId, elementId);
    const { frameId, localId } = splitElementId(elementId);
    let resp = await this.sendToFrame(tabId, frameId, build(frameId, localId));
    if (!resp.ok && resp.error === "ELEMENT_NOT_FOUND") {
      // 1) refresh snapshot  2) semantic match  3) retry once
      const remapped = await this.refreshAndRemap(tabId, oldDescriptor);
      if (remapped) {
        resp = await this.sendToFrame(tabId, remapped.frameId, build(remapped.frameId, remapped.localId));
        if (resp.ok) elementId = remapped.elementId;
      }
    }
    if (!resp.ok) throw this.toToolError(resp);
    const navigationObserved = opts.settleAfterAction
      ? await this.settleAfterPotentialNavigation(tabId, before?.url ?? "")
      : false;
    return this.buildInteractionResult(tabId, elementId, resp, before, navigationObserved);
  }

  private async refreshAndRemap(
    tabId: number,
    old: MatchCandidate | null,
  ): Promise<{ elementId: string; frameId: number; localId: string } | null> {
    if (!old) return null;
    this.invalidate(tabId);
    const fresh = await this.getSnapshot(tabId, { maxElements: 120, includeValues: false });
    const candidates: MatchCandidate[] = fresh.elements.map((e) => ({
      id: e.id,
      role: e.role,
      name: e.name,
      tag: e.tag,
      type: e.type,
      href: e.href,
    }));
    const match = findBestSemanticMatch(old, candidates);
    if (!match.id) return null;
    const { frameId, localId } = splitElementId(match.id);
    return { elementId: match.id, frameId, localId };
  }

  /** Captures stale identity before invalidating any cached snapshots. */
  private cachedElementDescriptor(tabId: number, elementId: string): MatchCandidate | null {
    const entries = this.snapshots.get(tabId) ?? [];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const match = this.findInElements(entries[index].snapshot.elements, elementId);
      if (match) return match;
    }
    return null;
  }

  private findInElements(elements: PageSnapshot["elements"], elementId: string): MatchCandidate | null {
    const el = elements.find((e) => e.id === elementId);
    if (!el) return null;
    const ident = identityOfElement(el);
    return { id: el.id, role: ident.role, name: ident.name, tag: ident.tag, type: ident.type, href: ident.href };
  }

  private async buildInteractionResult(
    tabId: number,
    _elementId: string,
    resp: ContentResponse,
    before: TabMeta | null = null,
    navigationObserved = false,
  ): Promise<InteractionResult> {
    if (!resp.ok) throw this.toToolError(resp);
    let meta = await this.getTab(tabId);
    const data = (resp.data ?? {}) as Record<string, unknown>;
    this.invalidate(tabId);
    // Refresh cache so the next turn sees the post-interaction page.
    let newElements: InteractionResult["newElements"] = [];
    if (meta?.status !== "loading") try {
      const snap = await this.getSnapshot(tabId, { maxElements: 30, maxTextChars: 0, maxLinks: 0, includeFrames: true });
      newElements = snap.elements
        .filter((e) => e.visible)
        .slice(0, 30)
        .map((e) => ({ id: e.id, role: e.role, name: e.name.slice(0, 100) }));
    } catch {
      /* internal pages: no snapshot */
    }
    meta = await this.getTab(tabId);
    const action = String(data.action ?? "action");
    const pageChanged = navigationObserved || (!!before && !!meta && before.url !== meta.url);
    const documentLoading = meta?.status === "loading";
    const networkIdle = meta?.ready ?? !documentLoading;
    const observation = [
      `${capitalize(action)} successful.`,
      pageChanged ? "The page changed after the action." : "",
      documentLoading ? "The document is still loading. Further page actions will wait for it." : "",
      !documentLoading && !networkIdle ? "Background page API activity is continuing; the bounded wait elapsed, so the completed document remains usable." : "",
      meta ? `\nPage: "${meta.title}"\nURL: ${meta.url}` : "",
      newElements.length ? `\nCurrent visible elements:\n${newElements.map((e) => `[${e.id}] ${e.role} "${e.name}"`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      success: true,
      observation,
      pageChanged,
      networkIdle,
      newElements,
      tabId,
      url: meta?.url ?? "",
      title: meta?.title ?? "",
    };
  }

  clickElement(tabId: number, elementId: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "click", elementId: localId }), { settleAfterAction: true });
  }

  typeText(tabId: number, elementId: string, text: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "type_text", elementId: localId, text }));
  }

  clearInput(tabId: number, elementId: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "clear_input", elementId: localId }));
  }

  selectOption(tabId: number, elementId: string, value: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "select_option", elementId: localId, value }));
  }

  setChecked(tabId: number, elementId: string, checked: boolean): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "check", elementId: localId, checked }));
  }

  scroll(tabId: number, dx: number, dy: number): Promise<InteractionResult> {
    return this.sendToFrame(tabId, 0, { kind: "scroll", dx, dy }).then((resp) => {
      if (!resp.ok) throw this.toToolError(resp);
      return this.buildInteractionResult(tabId, "", resp);
    });
  }

  scrollToElement(tabId: number, elementId: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "scroll_to_element", elementId: localId }));
  }

  hover(tabId: number, elementId: string): Promise<InteractionResult> {
    return this.interact(tabId, elementId, (_f, localId) => ({ kind: "hover", elementId: localId }));
  }

  async pressKey(tabId: number, key: string, elementId?: string): Promise<InteractionResult> {
    if (elementId) {
      return this.interact(tabId, elementId, (_f, localId) => ({ kind: "press_key", key, elementId: localId }), {
        settleAfterAction: key === "Enter",
      });
    }
    const before = await this.getTab(tabId);
    const resp = await this.sendToFrame(tabId, 0, { kind: "press_key", key });
    const navigationObserved = key === "Enter" ? await this.settleAfterPotentialNavigation(tabId, before?.url ?? "") : false;
    return this.buildInteractionResult(tabId, "", resp, before, navigationObserved);
  }

  /** Gives navigation and asynchronous DOM handlers a short chance to settle. */
  private async settleAfterPotentialNavigation(tabId: number, beforeUrl: string): Promise<boolean> {
    const startedAt = Date.now();
    const quietDeadline = startedAt + 400;
    const hardDeadline = startedAt + 10_000;
    let navigationObserved = false;

    while (Date.now() < hardDeadline) {
      try {
        const tab = await browser.tabs.get(tabId);
        if ((tab.url ?? "") !== beforeUrl || tab.status === "loading") navigationObserved = true;
        if (navigationObserved && tab.status === "complete") return true;
        if (!navigationObserved && Date.now() >= quietDeadline) return false;
      } catch {
        return navigationObserved;
      }
      await sleep(100);
    }
    return navigationObserved;
  }

  async restoreInput(tabId: number, elementId: string): Promise<InteractionResult> {
    const { frameId, localId } = splitElementId(elementId);
    const resp = await this.sendToFrame(tabId, frameId, { kind: "restore_input", elementId: localId });
    if (!resp.ok) throw this.toToolError(resp);
    return this.buildInteractionResult(tabId, elementId, resp);
  }

  async describeElement(tabId: number, elementId: string): Promise<ElementDescriptor | null> {
    const { frameId, localId } = splitElementId(elementId);
    try {
      const resp = await this.sendToFrame(tabId, frameId, { kind: "describe_element", elementId: localId });
      if (!resp.ok) return null;
      return resp.data as ElementDescriptor;
    } catch (err) {
      if (err instanceof ToolError) throw err;
      return null;
    }
  }

  async undoInput(tabId: number, elementId: string): Promise<InteractionResult> {
    const { frameId, localId } = splitElementId(elementId);
    const resp = await this.sendToFrame(tabId, frameId, { kind: "undo_input", elementId: localId });
    if (!resp.ok) throw this.toToolError(resp);
    return this.buildInteractionResult(tabId, elementId, resp);
  }

  // -------------------------------------------------------------------------
  // Undo support
  // -------------------------------------------------------------------------

  recordUndoable(action: UndoableAction): void {
    this.undoStack.push(action);
    if (this.undoStack.length > 50) this.undoStack.shift();
  }

  popUndoable(): UndoableAction | undefined {
    return this.undoStack.pop();
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private async withTab(tabId: number, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no tab|invalid tab/i.test(msg)) {
        throw new ToolError("TAB_NOT_FOUND", `Tab ${tabId} no longer exists.`, { suggestedAction: "List tabs and pick an existing one." });
      }
      throw new ToolError("INTERNAL_ERROR", msg);
    }
  }

  private toToolError(resp: ContentResponse): ToolError {
    if (!resp.ok) {
      return new ToolError(resp.error, resp.message, {
        suggestedAction: resp.suggestedAction,
        ...(resp.newElementId ? { suggestedAction: `${resp.suggestedAction ?? ""} Try element ${resp.newElementId}.` } : {}),
      });
    }
    return new ToolError("INTERNAL_ERROR", "Unexpected content response");
  }
}

function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function normalizeSnapshotOptions(opts: SnapshotRequestOptions): NormalizedSnapshotOptions {
  return {
    maxTextChars: opts.maxTextChars ?? DEFAULT_SNAPSHOT_OPTIONS.maxTextChars,
    maxElements: opts.maxElements ?? DEFAULT_SNAPSHOT_OPTIONS.maxElements,
    maxLinks: opts.maxLinks ?? DEFAULT_SNAPSHOT_OPTIONS.maxLinks,
    includeValues: opts.includeValues ?? DEFAULT_SNAPSHOT_OPTIONS.includeValues,
    includeFrames: opts.includeFrames ?? DEFAULT_SNAPSHOT_OPTIONS.includeFrames,
  };
}

function snapshotSatisfies(cached: NormalizedSnapshotOptions, requested: NormalizedSnapshotOptions): boolean {
  return cached.maxTextChars >= requested.maxTextChars
    && cached.maxElements >= requested.maxElements
    && cached.maxLinks >= requested.maxLinks
    && (cached.includeValues || !requested.includeValues)
    // Frame content cannot be cleanly removed from merged text, so require the
    // same frame policy instead of returning more data than requested.
    && cached.includeFrames === requested.includeFrames;
}

function projectSnapshot(snapshot: PageSnapshot, requested: NormalizedSnapshotOptions): PageSnapshot {
  const text = snapshot.text.slice(0, requested.maxTextChars);
  const elements = snapshot.elements.slice(0, requested.maxElements).map((element) =>
    requested.includeValues ? element : { ...element, value: undefined },
  );
  return {
    ...snapshot,
    text,
    elements,
    links: snapshot.links.slice(0, requested.maxLinks),
    truncated: snapshot.truncated || snapshot.text.length > text.length,
  };
}

function compactSnapshotElements(snapshot: PageSnapshot, max: number): InteractionResult["newElements"] {
  return snapshot.elements
    .filter((element) => element.visible)
    .slice(0, max)
    .map((element) => ({ id: element.id, role: element.role, name: element.name.slice(0, 100) }));
}

function formatCompactElements(elements: InteractionResult["newElements"]): string {
  return elements.map((element) => `[${element.id}] ${element.role} "${element.name}"`).join("\n");
}

/** Converts a page URL to the match-pattern form used by permissions.contains. */
function hostPermissionPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return "file:///*";
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

/** Converts a WebExtension Tab into our TabMeta (windowId is always present in Firefox). */
function toTabMeta(t: browser.tabs.Tab): TabMeta {
  return {
    id: t.id ?? -1,
    title: t.title ?? "",
    url: t.url ?? "",
    active: t.active,
    windowId: t.windowId ?? -1,
    pinned: t.pinned,
    status: t.status === "loading" || t.status === "complete" ? t.status : undefined,
  };
}
