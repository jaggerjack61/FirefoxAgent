/**
 * IndexedDB-backed MemoryStore implementation. Runs in the background
 * script (extension origin), so page scripts can never touch it.
 */

import type { ConversationRecord, ChatMessageRecord, Fact, ProviderConfig, Workspace } from "@/shared/types";
import type { MemoryStore, TaskRecord } from "./MemoryStore";

const DB_NAME = "firefox-agent";
const DB_VERSION = 1;

const STORES = ["conversations", "messages", "workspace", "facts", "tasks", "kv"] as const;
type StoreName = (typeof STORES)[number];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB open failed"));
  });
}

async function tx<T>(store: StoreName, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error(`IndexedDB ${store} error`));
    t.oncomplete = () => db.close();
    t.onerror = () => {
      db.close();
      reject(t.error ?? new Error(`IndexedDB ${store} transaction error`));
    };
  });
}

async function put(store: StoreName, value: unknown): Promise<void> {
  await tx(store, "readwrite", (s) => s.put(value as never));
}

async function get<T>(store: StoreName, id: string): Promise<T | null> {
  const result = await tx<T | undefined>(store, "readonly", (s) => s.get(id));
  return result ?? null;
}

async function getAll<T>(store: StoreName): Promise<T[]> {
  return tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>);
}

async function del(store: StoreName, id: string): Promise<void> {
  await tx(store, "readwrite", (s) => s.delete(id));
}

async function clear(store: StoreName): Promise<void> {
  await tx(store, "readwrite", (s) => s.clear());
}

export class IndexedDbMemoryStore implements MemoryStore {
  // -- conversations --------------------------------------------------------
  saveConversation(conv: ConversationRecord): Promise<void> {
    return put("conversations", conv);
  }
  loadConversation(id: string): Promise<ConversationRecord | null> {
    return get<ConversationRecord>("conversations", id);
  }
  async loadAllConversations(): Promise<ConversationRecord[]> {
    return getAll<ConversationRecord>("conversations");
  }
  deleteConversation(id: string): Promise<void> {
    return del("conversations", id);
  }

  // -- messages -------------------------------------------------------------
  saveMessage(msg: ChatMessageRecord): Promise<void> {
    return put("messages", msg);
  }
  async loadMessages(conversationId: string): Promise<ChatMessageRecord[]> {
    const all = await getAll<ChatMessageRecord>("messages");
    return all
      .filter((m) => m.conversationId === conversationId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  async clearConversationMessages(conversationId: string): Promise<void> {
    const all = await getAll<ChatMessageRecord>("messages");
    for (const m of all) {
      if (m.conversationId === conversationId) await del("messages", m.id);
    }
  }

  // -- workspace ------------------------------------------------------------
  async saveWorkspace(ws: Workspace): Promise<void> {
    await put("workspace", { id: "current", ws });
  }
  async loadWorkspace(): Promise<Workspace | null> {
    const entry = await get<{ id: string; ws: Workspace }>("workspace", "current");
    return entry?.ws ?? null;
  }

  // -- facts ----------------------------------------------------------------
  saveFacts(facts: Fact[]): Promise<void> {
    const stored = facts.map((f) => ({ ...f, id: `mem_${f.id}` }));
    return put("facts", { id: "longterm", facts: stored });
  }
  async loadFacts(): Promise<Fact[]> {
    const entry = await get<{ id: string; facts: Fact[] }>("facts", "longterm");
    return entry?.facts ?? [];
  }
  async clearFacts(): Promise<void> {
    await del("facts", "longterm");
  }

  // -- tasks ----------------------------------------------------------------
  saveTask(task: TaskRecord): Promise<void> {
    return put("tasks", task);
  }
  loadTask(id: string): Promise<TaskRecord | null> {
    return get<TaskRecord>("tasks", id);
  }

  // -- provider -------------------------------------------------------------
  saveProvider(config: ProviderConfig): Promise<void> {
    return put("kv", { id: "provider", config });
  }
  async loadProvider(): Promise<ProviderConfig | null> {
    const entry = await get<{ id: string; config: ProviderConfig }>("kv", "provider");
    return entry?.config ?? null;
  }

  // -- maintenance ----------------------------------------------------------
  async clearAll(): Promise<void> {
    for (const s of STORES) await clear(s);
  }
}
