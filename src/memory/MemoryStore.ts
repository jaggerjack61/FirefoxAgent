/**
 * MemoryStore: durable local state interface backed by IndexedDB.
 * Stores conversations, messages, workspace, facts, task state and
 * provider selection. Raw page contents are never persisted by default.
 */

import type { ConversationRecord, ChatMessageRecord, Fact, ProviderConfig, Workspace } from "@/shared/types";

export interface TaskRecord {
  id: string;
  goal: string;
  status: string;
  workspaceId?: string;
  data: unknown;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryEntry {
  key: string;
  value: unknown;
}

export interface MemoryStore {
  // conversations
  saveConversation(conv: ConversationRecord): Promise<void>;
  loadConversation(id: string): Promise<ConversationRecord | null>;
  loadAllConversations(): Promise<ConversationRecord[]>;
  deleteConversation(id: string): Promise<void>;
  // messages
  saveMessage(msg: ChatMessageRecord): Promise<void>;
  loadMessages(conversationId: string): Promise<ChatMessageRecord[]>;
  clearConversationMessages(conversationId: string): Promise<void>;
  // workspace
  saveWorkspace(ws: Workspace): Promise<void>;
  loadWorkspace(): Promise<Workspace | null>;
  // facts / memory
  saveFacts(facts: Fact[]): Promise<void>;
  loadFacts(): Promise<Fact[]>;
  clearFacts(): Promise<void>;
  // task state
  saveTask(task: TaskRecord): Promise<void>;
  loadTask(id: string): Promise<TaskRecord | null>;
  // provider selection + settings persistence
  saveProvider(config: ProviderConfig): Promise<void>;
  loadProvider(): Promise<ProviderConfig | null>;
  // maintenance
  clearAll(): Promise<void>;
}
