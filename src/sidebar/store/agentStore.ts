/**
 * Sidebar store (Zustand): mirrors background state, driven by pushed
 * events. All UI components read from this store; nothing calls the
 * background directly except through the action methods.
 */

import { create } from "zustand";
import type {
  ActionLogEntry,
  AgentRuntimeState,
  AppSettings,
  ChatMessageRecord,
  ConfirmationRequest,
  ConversationRecord,
  DevEvent,
  ToolActivityRecord,
  Workspace,
} from "@/shared/types";
import type { BackgroundEvent } from "@/shared/events";
import type { BootstrapPayload, SidebarRequest } from "@/shared/protocol";
import { getRuntime } from "../lib/runtime";

type View = "chat" | "context" | "activity" | "settings" | "dev";

interface AgentState {
  view: View;
  bootstrapped: boolean;
  hasSiteAccess: boolean;
  settings: AppSettings | null;
  runtimeState: AgentRuntimeState;
  conversation: ConversationRecord | null;
  messages: ChatMessageRecord[];
  workspace: Workspace | null;
  activity: ToolActivityRecord[];
  actionLog: ActionLogEntry[];
  pendingConfirmation: ConfirmationRequest | null;
  devEvents: DevEvent[];
  streamingText: string;
  busy: boolean;
  activeTabId?: number;

  setView(view: View): void;
  bootstrap(): Promise<void>;
  sendMessage(text: string): Promise<void>;
  stop(): void;
  newConversation(): Promise<void>;
  newWorkspace(name?: string): Promise<void>;
  workspaceAddTab(tabId: number, pinned?: boolean): Promise<void>;
  workspaceAddAllTabs(): Promise<void>;
  workspaceRemoveTab(tabId: number): Promise<void>;
  workspaceClear(): Promise<void>;
  workspacePinTab(tabId: number, pinned: boolean): Promise<void>;
  respondConfirmation(requestId: string, approved: boolean): Promise<void>;
  saveSettings(settings: AppSettings): Promise<void>;
  clearConversation(): Promise<void>;
  clearRememberedPages(): Promise<void>;
  deleteAllData(): Promise<void>;
  ensurePermissions(): Promise<void>;
  refreshDevEvents(): Promise<void>;
  /** Fetches available models from the provider's /models endpoint. */
  fetchModels(): Promise<string[]>;
  /** Applies a pushed background event to the store (used by App shell). */
  applyEvent(event: BackgroundEvent): void;
}

const initialState: Omit<AgentState, keyof AgentStateActions | "applyEvent"> & { applyEvent?: (event: BackgroundEvent) => void } = {
  view: "chat",
  bootstrapped: false,
  hasSiteAccess: false,
  settings: null,
  runtimeState: { status: "idle", iterations: 0 },
  conversation: null,
  messages: [],
  workspace: null,
  activity: [],
  actionLog: [],
  pendingConfirmation: null,
  devEvents: [],
  streamingText: "",
  busy: false,
  activeTabId: undefined,
  applyEvent: () => undefined,
};

type AgentStateActions = Pick<
  AgentState,
  | "setView"
  | "bootstrap"
  | "sendMessage"
  | "stop"
  | "newConversation"
  | "newWorkspace"
  | "workspaceAddTab"
  | "workspaceAddAllTabs"
  | "workspaceRemoveTab"
  | "workspaceClear"
  | "workspacePinTab"
  | "respondConfirmation"
  | "saveSettings"
  | "clearConversation"
  | "clearRememberedPages"
  | "deleteAllData"
  | "ensurePermissions"
  | "refreshDevEvents"
  | "fetchModels"
>;

export const useAgentStore = create<AgentState>()((set, get) => {
  const runtime = getRuntime();

  const applyEvent = (event: BackgroundEvent): void => {
    switch (event.type) {
      case "AGENT_STATE":
        set({ runtimeState: event.state, busy: event.state.status === "running" || event.state.status === "planning" });
        break;
      case "STREAM_DELTA":
        set((s) => ({ streamingText: s.streamingText + event.text }));
        break;
      case "STREAM_DONE":
        set({ streamingText: "" });
        break;
      case "MESSAGE_ADDED": {
        const message = event.message;
        set((s) => ({
          messages: s.messages.some((m) => m.id === message.id) ? s.messages : [...s.messages, message],
        }));
        break;
      }
      case "ACTIVITY":
      case "ACTIVITY_UPDATED":
        set((s) => {
          const idx = s.activity.findIndex((a) => a.id === event.activity.id);
          const activity = idx === -1 ? [...s.activity, event.activity] : s.activity.map((a, i) => (i === idx ? event.activity : a));
          return { activity: activity.slice(-50) };
        });
        break;
      case "CONFIRMATION_REQUESTED":
        set({ pendingConfirmation: event.request });
        break;
      case "CONFIRMATION_RESOLVED":
        set((s) => (s.pendingConfirmation?.id === event.requestId ? { pendingConfirmation: null } : {}));
        break;
      case "WORKSPACE_CHANGED":
        set({ workspace: event.workspace });
        break;
      case "ACTION_LOG":
        set((s) => ({ actionLog: [...s.actionLog, event.entry].slice(-200) }));
        break;
      case "CONVERSATION_RESET":
        set({ conversation: null, messages: [], activity: [], actionLog: [], streamingText: "" });
        break;
      case "DEV_EVENT":
        if (get().settings?.devMode) {
          set((s) => ({ devEvents: [...s.devEvents, event.event].slice(-300) }));
        }
        break;
    }
  };

  const send = async (type: SidebarRequest["type"], body: Record<string, unknown> = {}) => {
    const res = (await runtime.send({ type, ...body } as SidebarRequest)) as { ok: boolean; [k: string]: unknown };
    if (!res.ok) throw new Error(String(res.error ?? `Request ${type} failed`));
    return res;
  };

  void send;

  return {
    ...initialState,

    applyEvent,
    setView: (view) => set({ view }),

    async bootstrap() {
      const res = (await runtime.send({ type: "GET_BOOTSTRAP" })) as { ok: boolean; bootstrap?: BootstrapPayload };
      if (!res.ok || !res.bootstrap) {
        set({ bootstrapped: true });
        return;
      }
      const b: BootstrapPayload = res.bootstrap;
      set({
        bootstrapped: true,
        settings: b.settings,
        runtimeState: b.runtimeState,
        conversation: b.conversation,
        messages: b.messages,
        workspace: b.workspace,
        activity: b.activity,
        actionLog: b.actionLog,
        pendingConfirmation: b.pendingConfirmation,
        hasSiteAccess: b.hasSiteAccess,
        activeTabId: b.activeTabId,
        busy: b.runtimeState.status === "running" || b.runtimeState.status === "planning",
      });
    },

    async sendMessage(text) {
      const res = await runtime.send({ type: "SEND_USER_MESSAGE", text });
      if (!res.ok) {
        throw new Error(res.error ?? "Failed to send message");
      }
    },

    stop: () => void runtime.send({ type: "STOP_AGENT" }),

    async newConversation() {
      const res = await runtime.send({ type: "NEW_CONVERSATION" });
      if (!res.ok) throw new Error(res.error ?? "Failed to start a new chat");
    },

    async newWorkspace(name) {
      await runtime.send({ type: "NEW_WORKSPACE", name: name ?? "Research" });
    },

    async workspaceAddTab(tabId, pinned) {
      await runtime.send({ type: "WORKSPACE_ADD_TAB", tabId, pinned: pinned ?? false });
    },

    async workspaceAddAllTabs() {
      await runtime.send({ type: "WORKSPACE_ADD_ALL_TABS" });
    },

    async workspaceRemoveTab(tabId) {
      await runtime.send({ type: "WORKSPACE_REMOVE_TAB", tabId });
    },

    async workspaceClear() {
      await runtime.send({ type: "WORKSPACE_CLEAR" });
    },

    async workspacePinTab(tabId, pinned) {
      await runtime.send({ type: "WORKSPACE_PIN_TAB", tabId, pinned });
    },

    async respondConfirmation(requestId, approved) {
      await runtime.send({ type: "CONFIRMATION_RESPONSE", requestId, approved });
    },

    async saveSettings(settings) {
      const res = (await runtime.send({ type: "SET_SETTINGS", settings, partial: false })) as { ok: boolean; settings?: AppSettings; error?: string };
      if (!res.ok || !res.settings) throw new Error(res.error ?? "Failed to save settings");
      set({ settings: res.settings });
    },

    async clearConversation() {
      await runtime.send({ type: "CLEAR_CONVERSATION" });
    },

    async clearRememberedPages() {
      await runtime.send({ type: "CLEAR_REMEMBERED_PAGES" });
    },

    async deleteAllData() {
      await runtime.send({ type: "DELETE_ALL_LOCAL_DATA" });
      await get().bootstrap();
    },

    async ensurePermissions() {
      const res = await runtime.send({ type: "ENSURE_PERMISSIONS" });
      set({ hasSiteAccess: res.ok });
    },

    async refreshDevEvents() {
      const res = (await runtime.send({ type: "GET_DEV_EVENTS" })) as { ok: boolean; devEvents?: DevEvent[] };
      if (res.ok && res.devEvents) set({ devEvents: res.devEvents });
    },

    async fetchModels() {
      const res = (await runtime.send({ type: "FETCH_MODELS" })) as { ok: boolean; models?: string[]; error?: string };
      if (!res.ok) throw new Error(res.error ?? "Failed to fetch models");
      return res.models ?? [];
    },
  };
});
