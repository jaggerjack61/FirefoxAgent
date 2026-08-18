/**
 * Typed extension-internal message protocol.
 *
 * Three channels exist:
 *  1. sidebar  <-> background : runtime messages (this file)
 *  2. background -> sidebar   : pushed events (src/shared/events.ts)
 *  3. background <-> content  : per-tab messages (src/shared/contentProtocol.ts)
 *
 * Every message is a discriminated union. No loosely typed payloads.
 */

import type {
  ActionLogEntry,
  AgentRuntimeState,
  AppSettings,
  ChatMessageRecord,
  ConfirmationRequest,
  ConversationRecord,
  DevEvent,
  TokenUsageMetrics,
  ToolActivityRecord,
  Workspace,
} from "./types";

// ---------------------------------------------------------------------------
// Sidebar -> background requests
// ---------------------------------------------------------------------------

export type SidebarRequest =
  | { type: "GET_BOOTSTRAP" }
  | { type: "GET_CONVERSATION"; conversationId: string }
  | { type: "GET_WORKSPACE" }
  | { type: "GET_ACTION_LOG" }
  | { type: "GET_SETTINGS" }
  | { type: "SET_SETTINGS"; settings: AppSettings; partial: boolean }
  | { type: "SEND_USER_MESSAGE"; text: string }
  | { type: "STOP_AGENT"; reason?: string }
  | { type: "NEW_CONVERSATION" }
  | { type: "NEW_WORKSPACE"; name?: string }
  | { type: "WORKSPACE_ADD_TAB"; tabId: number; pinned?: boolean }
  | { type: "WORKSPACE_ADD_ALL_TABS" }
  | { type: "WORKSPACE_REMOVE_TAB"; tabId: number }
  | { type: "WORKSPACE_CLEAR" }
  | { type: "WORKSPACE_PIN_TAB"; tabId: number; pinned: boolean }
  | { type: "CONFIRMATION_RESPONSE"; requestId: string; approved: boolean }
  | { type: "CLEAR_CONVERSATION" }
  | { type: "CLEAR_WORKSPACE" }
  | { type: "CLEAR_REMEMBERED_PAGES" }
  | { type: "DELETE_ALL_LOCAL_DATA" }
  | { type: "ENSURE_PERMISSIONS" }
  | { type: "FETCH_MODELS" }
  | { type: "GET_DEV_EVENTS" };

export interface BootstrapPayload {
  settings: AppSettings;
  runtimeState: AgentRuntimeState;
  conversation: ConversationRecord | null;
  messages: ChatMessageRecord[];
  workspace: Workspace | null;
  actionLog: ActionLogEntry[];
  activity: ToolActivityRecord[];
  pendingConfirmation: ConfirmationRequest | null;
  hasSiteAccess: boolean;
  activeTabId?: number;
  tokenUsage: TokenUsageMetrics;
}

export type SidebarResponse =
  | { ok: true; bootstrap: BootstrapPayload }
  | { ok: true; conversation: ConversationRecord | null; messages: ChatMessageRecord[] }
  | { ok: true; workspace: Workspace | null }
  | { ok: true; actionLog: ActionLogEntry[] }
  | { ok: true; settings: AppSettings }
  | { ok: true; accepted: boolean }
  | { ok: true; models: string[] }
  | { ok: true; devEvents: DevEvent[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Content script -> background notifications
// ---------------------------------------------------------------------------

export type ContentNotification =
  | { type: "PAGE_CHANGED"; tabId: number; url: string; reason: "history" | "mutation" | "navigation" }
  | { type: "SNAPSHOT_DIRTY"; tabId: number };

// ---------------------------------------------------------------------------
// Typed runtime message envelope
// ---------------------------------------------------------------------------

/** Union of everything that can arrive at `browser.runtime.onMessage` in any context. */
export type ExtensionMessage = SidebarRequest | ContentNotification;
