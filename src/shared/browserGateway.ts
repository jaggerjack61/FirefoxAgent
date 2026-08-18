/**
 * BrowserGateway — the *only* interface through which the agent touches the
 * browser. The real implementation wraps Firefox WebExtension APIs and
 * content-script messaging; tests inject a fake implementation.
 *
 * The LLM never sees this interface: tools are the layer above it, and the
 * agent loop only ever calls tools.
 */

import type { ContentResponse, PageSnapshot, SnapshotRequestOptions } from "./contentProtocol";
import type { ErrorCode } from "./errors";

export interface TabMeta {
  id: number;
  title: string;
  url: string;
  active: boolean;
  windowId: number;
  pinned?: boolean;
  /** Firefox's document loading state when available. */
  status?: "loading" | "complete";
  /** True only when the document is complete and page API traffic is idle. */
  ready?: boolean;
}

export interface OpenTabOptions {
  active?: boolean;
  /** Open as a background tab (research sessions). */
  background?: boolean;
  windowId?: number;
  index?: number;
}

export interface InteractionResult {
  success: boolean;
  /** Tab on which the action was executed. */
  tabId: number;
  /** Compact observation for the model — NOT the full DOM. */
  observation: string;
  error?: { code: ErrorCode; message: string; suggestedAction?: string };
  /** True when the page likely changed (URL/navigation). */
  pageChanged: boolean;
  /** False when bounded waiting ended while page APIs remained active. */
  networkIdle?: boolean;
  /** Fresh compact element list after the interaction (capped). */
  newElements: { id: string; role: string; name: string }[];
  url: string;
  title: string;
}

export interface NavigateResult extends InteractionResult {
  finalUrl: string;
  loaded: boolean;
  /** False when a bounded wait ended while background page APIs remained active. */
  networkIdle?: boolean;
}

export type DownloadConflictAction = "uniquify" | "overwrite" | "prompt";

export interface DownloadFileOptions {
  /** Path relative to the browser's Downloads directory. */
  filename?: string;
  /** Ask Firefox to show its file chooser. */
  saveAs?: boolean;
  conflictAction?: DownloadConflictAction;
}

export interface DownloadResult {
  queued: true;
  downloadId: number;
  url: string;
  requestedFilename?: string;
  saveAs: boolean;
  conflictAction: DownloadConflictAction;
}

export interface BrowserGateway {
  // ---- tabs ---------------------------------------------------------------
  listTabs(): Promise<TabMeta[]>;
  getActiveTab(): Promise<TabMeta | null>;
  getTab(tabId: number): Promise<TabMeta | null>;
  switchTab(tabId: number): Promise<void>;
  openTab(url: string, opts?: OpenTabOptions): Promise<TabMeta>;
  closeTab(tabId: number): Promise<void>;
  reloadTab(tabId: number): Promise<void>;
  duplicateTab(tabId: number): Promise<TabMeta>;
  goBack(tabId: number): Promise<void>;
  goForward(tabId: number): Promise<void>;
  restoreClosedTab(sessionId: string): Promise<TabMeta | null>;
  /** Waits for document completion plus page fetch/XHR network idle (bounded). */
  waitForTabReady(tabId: number, timeoutMs?: number): Promise<boolean>;

  // ---- navigation ---------------------------------------------------------
  /** Navigates a tab and waits for load completion (bounded). */
  navigate(tabId: number, url: string, opts?: { timeoutMs?: number }): Promise<NavigateResult>;

  // ---- downloads ----------------------------------------------------------
  /** Queues a URL with Firefox's download manager. File type is unrestricted. */
  downloadFile(url: string, opts?: DownloadFileOptions): Promise<DownloadResult>;

  // ---- content scripts ----------------------------------------------------
  hasHostAccess(url: string): Promise<boolean>;
  ensureContentScripts(): Promise<void>;
  /** True when a content script is (or can be made) available in the tab. */
  isContentScriptAvailable(tabId: number): Promise<boolean>;
  getSnapshot(tabId: number, opts?: SnapshotRequestOptions): Promise<PageSnapshot>;
  /** Sends a typed request to the content script in the given frame. */
  sendToFrame(tabId: number, frameId: number, request: { kind: string; [k: string]: unknown }): Promise<ContentResponse>;

  // ---- interactions (convenience wrappers that also refresh snapshots) ----
  clickElement(tabId: number, elementId: string): Promise<InteractionResult>;
  typeText(tabId: number, elementId: string, text: string): Promise<InteractionResult>;
  clearInput(tabId: number, elementId: string): Promise<InteractionResult>;
  selectOption(tabId: number, elementId: string, value: string): Promise<InteractionResult>;
  setChecked(tabId: number, elementId: string, checked: boolean): Promise<InteractionResult>;
  scroll(tabId: number, dx: number, dy: number): Promise<InteractionResult>;
  scrollToElement(tabId: number, elementId: string): Promise<InteractionResult>;
  hover(tabId: number, elementId: string): Promise<InteractionResult>;
  pressKey(tabId: number, key: string, elementId?: string): Promise<InteractionResult>;
  restoreInput(tabId: number, elementId: string): Promise<InteractionResult>;
  undoInput(tabId: number, elementId: string): Promise<InteractionResult>;

  /**
   * Pre-execution element descriptor used by the confirmation policy
   * (name, role, type, whether the element is inside a form). Returns null
   * when the element cannot be resolved.
   */
  describeElement(tabId: number, elementId: string): Promise<ElementDescriptor | null>;

  // ---- undo support -------------------------------------------------------
  /** Records an undoable action (closed tab, url change, input value). */
  recordUndoable(action: UndoableAction): void;
  popUndoable(): UndoableAction | undefined;
}

export type UndoableAction =
  | { kind: "close_tab"; tabId: number; sessionId: string }
  | { kind: "input_value"; tabId: number; frameId: number; elementId: string; previousValue: string };

export interface ElementDescriptor {
  name: string;
  role: string;
  tag: string;
  type?: string;
  checked?: boolean;
  /** True when the element is a form control inside a <form>. */
  inForm: boolean;
}

export interface UndoResult {
  success: boolean;
  observation: string;
}
