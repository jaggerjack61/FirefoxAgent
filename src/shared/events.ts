/**
 * Background -> sidebar pushed events. The sidebar subscribes to these via
 * `browser.runtime.onMessage` and updates its local Zustand store.
 */

import type {
  ActionLogEntry,
  AgentRuntimeState,
  ChatMessageRecord,
  ConfirmationRequest,
  DevEvent,
  ToolActivityRecord,
  Workspace,
} from "./types";

export type BackgroundEvent =
  | { type: "AGENT_STATE"; state: AgentRuntimeState }
  | { type: "STREAM_DELTA"; text: string }
  | { type: "STREAM_DONE" }
  | { type: "MESSAGE_ADDED"; message: ChatMessageRecord }
  | { type: "ACTIVITY"; activity: ToolActivityRecord }
  | { type: "ACTIVITY_UPDATED"; activity: ToolActivityRecord }
  | { type: "CONFIRMATION_REQUESTED"; request: ConfirmationRequest }
  | { type: "CONFIRMATION_RESOLVED"; requestId: string; approved: boolean }
  | { type: "WORKSPACE_CHANGED"; workspace: Workspace }
  | { type: "ACTION_LOG"; entry: ActionLogEntry }
  | { type: "CONVERSATION_RESET"; conversationId: string }
  | { type: "DEV_EVENT"; event: DevEvent };

export interface EventEnvelope {
  event: true;
  payload: BackgroundEvent;
}
