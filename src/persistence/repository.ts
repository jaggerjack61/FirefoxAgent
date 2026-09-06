import {
  actionRecordSchema,
  conversationRecordSchema,
  messageRecordSchema,
  modelTurnRecordSchema,
  promptPlanSchema,
  runRecordSchema,
  tokenUsageSchema,
  workspaceNoteSchema,
  workspaceRecordSchema,
  type ActionRecord,
  type ConversationRecord,
  type MessageRecord,
  type ModelTurnRecord,
  type RunRecord,
  type TokenUsage,
  type WorkspaceNote,
  type PromptPlan,
  type WorkspaceRecord,
} from "@/shared/schema";
import { createId } from "@/shared/token";

const DB_NAME = "browseragent-v1";
const DB_VERSION = 2;
const LEGACY_DB_NAME = "firefox-agent";

type StoreName =
  | "workspaces"
  | "conversations"
  | "messages"
  | "modelTurns"
  | "notes"
  | "runs"
  | "usage"
  | "actions"
  | "promptPlans"
  | "kv";

export interface BootstrapRecords {
  workspace: WorkspaceRecord;
  conversation: ConversationRecord;
}

export interface Repository {
  bootstrap(): Promise<BootstrapRecords>;
  getWorkspace(): Promise<WorkspaceRecord>;
  setCurrentWorkspace(id: string): Promise<void>;
  listMessages(conversationId: string): Promise<MessageRecord[]>;
  putMessage(message: MessageRecord): Promise<void>;
  listModelTurns(conversationId: string): Promise<ModelTurnRecord[]>;
  putModelTurn(turn: ModelTurnRecord): Promise<void>;
  putRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  getActiveRun(): Promise<RunRecord | null>;
  interruptActiveRuns(): Promise<void>;
  listNotes(workspaceId: string): Promise<WorkspaceNote[]>;
  putNote(note: WorkspaceNote): Promise<void>;
  deleteNote(id: string): Promise<void>;
  listUsage(runId?: string): Promise<TokenUsage[]>;
  putUsage(usage: TokenUsage): Promise<void>;
  putPromptPlan(plan: PromptPlan): Promise<void>;
  putAction(action: ActionRecord): Promise<void>;
  listActions(runId?: string): Promise<ActionRecord[]>;
  createWorkspace(name: string): Promise<BootstrapRecords>;
  resetCurrentWorkspace(): Promise<BootstrapRecords>;
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbRepository implements Repository {
  private dbPromise: Promise<IDBDatabase> | null = null;

  async resetLegacy(): Promise<void> {
    await new Promise<void>((resolve) => {
      const deletion = indexedDB.deleteDatabase(LEGACY_DB_NAME);
      deletion.onsuccess = () => resolve();
      deletion.onerror = () => resolve();
      deletion.onblocked = () => resolve();
    });
  }

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        const simpleStores: StoreName[] = [
          "workspaces",
          "conversations",
          "runs",
          "usage",
          "actions",
          "promptPlans",
          "kv",
        ];
        for (const name of simpleStores) {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("messages")) {
          const messages = db.createObjectStore("messages", { keyPath: "id" });
          messages.createIndex("conversationId", "conversationId");
        }
        if (!db.objectStoreNames.contains("modelTurns")) {
          const modelTurns = db.createObjectStore("modelTurns", { keyPath: "id" });
          modelTurns.createIndex("conversationId", "conversationId");
        }
        if (!db.objectStoreNames.contains("notes")) {
          const notes = db.createObjectStore("notes", { keyPath: "id" });
          notes.createIndex("workspaceId", "workspaceId");
        }
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error ?? new Error("Unable to open BrowserAgent database"));
    });
    return this.dbPromise;
  }

  async bootstrap(): Promise<BootstrapRecords> {
    const db = await this.open();
    const tx = db.transaction(["kv", "workspaces", "conversations"], "readwrite");
    const kv = tx.objectStore("kv");
    const existing = await request<{ id: string; value: string } | undefined>(kv.get("currentWorkspace"));
    if (existing) {
      const workspaceRaw = await request<WorkspaceRecord>(tx.objectStore("workspaces").get(existing.value));
      const conversationRaw = await request<ConversationRecord>(
        tx.objectStore("conversations").get(workspaceRaw.conversationId),
      );
      await transactionDone(tx);
      return {
        workspace: workspaceRecordSchema.parse(workspaceRaw),
        conversation: conversationRecordSchema.parse(conversationRaw),
      };
    }

    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: createId("workspace"),
      conversationId: createId("conversation"),
      name: "My workspace",
      createdAt: now,
      updatedAt: now,
    };
    const conversation: ConversationRecord = {
      id: workspace.conversationId,
      workspaceId: workspace.id,
      createdAt: now,
      updatedAt: now,
    };
    tx.objectStore("workspaces").put(workspace);
    tx.objectStore("conversations").put(conversation);
    kv.put({ id: "currentWorkspace", value: workspace.id });
    await transactionDone(tx);
    return { workspace, conversation };
  }

  async getWorkspace(): Promise<WorkspaceRecord> {
    return (await this.bootstrap()).workspace;
  }

  async setCurrentWorkspace(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction("kv", "readwrite");
    tx.objectStore("kv").put({ id: "currentWorkspace", value: id });
    await transactionDone(tx);
  }

  async createWorkspace(name: string): Promise<BootstrapRecords> {
    const db = await this.open();
    const now = Date.now();
    const workspace: WorkspaceRecord = {
      id: createId("workspace"),
      conversationId: createId("conversation"),
      name,
      createdAt: now,
      updatedAt: now,
    };
    const conversation: ConversationRecord = {
      id: workspace.conversationId,
      workspaceId: workspace.id,
      createdAt: now,
      updatedAt: now,
    };
    const tx = db.transaction(["kv", "workspaces", "conversations"], "readwrite");
    tx.objectStore("workspaces").put(workspace);
    tx.objectStore("conversations").put(conversation);
    tx.objectStore("kv").put({ id: "currentWorkspace", value: workspace.id });
    await transactionDone(tx);
    return { workspace, conversation };
  }

  async resetCurrentWorkspace(): Promise<BootstrapRecords> {
    const current = await this.bootstrap();
    const db = await this.open();
    const stores: StoreName[] = [
      "workspaces",
      "conversations",
      "messages",
      "modelTurns",
      "notes",
      "runs",
      "usage",
      "actions",
      "promptPlans",
    ];
    const tx = db.transaction(stores, "readwrite");
    const [conversations, messages, modelTurns, notes, runs, usage, actions, promptPlans] = await Promise.all(
      [
        request<ConversationRecord[]>(tx.objectStore("conversations").getAll()),
        request<MessageRecord[]>(tx.objectStore("messages").getAll()),
        request<ModelTurnRecord[]>(tx.objectStore("modelTurns").getAll()),
        request<WorkspaceNote[]>(tx.objectStore("notes").getAll()),
        request<RunRecord[]>(tx.objectStore("runs").getAll()),
        request<TokenUsage[]>(tx.objectStore("usage").getAll()),
        request<ActionRecord[]>(tx.objectStore("actions").getAll()),
        request<PromptPlan[]>(tx.objectStore("promptPlans").getAll()),
      ],
    );

    const conversationIds = new Set(
      conversations
        .filter((conversation) => conversation.workspaceId === current.workspace.id)
        .map((conversation) => conversation.id),
    );
    conversationIds.add(current.workspace.conversationId);
    const runIds = new Set(
      runs.filter((run) => run.workspaceId === current.workspace.id).map((run) => run.id),
    );

    for (const conversation of conversations) {
      if (conversationIds.has(conversation.id)) tx.objectStore("conversations").delete(conversation.id);
    }
    for (const message of messages) {
      if (conversationIds.has(message.conversationId)) tx.objectStore("messages").delete(message.id);
    }
    for (const turn of modelTurns) {
      if (conversationIds.has(turn.conversationId) || runIds.has(turn.runId)) {
        tx.objectStore("modelTurns").delete(turn.id);
      }
    }
    for (const note of notes) {
      if (note.workspaceId === current.workspace.id) tx.objectStore("notes").delete(note.id);
    }
    for (const run of runs) {
      if (runIds.has(run.id)) tx.objectStore("runs").delete(run.id);
    }
    for (const item of usage) {
      if (runIds.has(item.runId)) tx.objectStore("usage").delete(item.id);
    }
    for (const action of actions) {
      if (runIds.has(action.runId)) tx.objectStore("actions").delete(action.id);
    }
    for (const plan of promptPlans) {
      if (runIds.has(plan.runId)) tx.objectStore("promptPlans").delete(plan.id);
    }

    const now = Date.now();
    const conversation: ConversationRecord = {
      id: createId("conversation"),
      workspaceId: current.workspace.id,
      createdAt: now,
      updatedAt: now,
    };
    const workspace: WorkspaceRecord = {
      ...current.workspace,
      conversationId: conversation.id,
      updatedAt: now,
    };
    tx.objectStore("conversations").put(conversation);
    tx.objectStore("workspaces").put(workspace);
    await transactionDone(tx);
    return {
      workspace: workspaceRecordSchema.parse(workspace),
      conversation: conversationRecordSchema.parse(conversation),
    };
  }

  async listMessages(conversationId: string): Promise<MessageRecord[]> {
    const db = await this.open();
    const tx = db.transaction("messages", "readonly");
    const rows = await request<MessageRecord[]>(
      tx.objectStore("messages").index("conversationId").getAll(conversationId),
    );
    await transactionDone(tx);
    return rows.map((row) => messageRecordSchema.parse(row)).sort((a, b) => a.createdAt - b.createdAt);
  }

  async putMessage(message: MessageRecord): Promise<void> {
    await this.put("messages", messageRecordSchema.parse(message));
  }

  async listModelTurns(conversationId: string): Promise<ModelTurnRecord[]> {
    const db = await this.open();
    const tx = db.transaction("modelTurns", "readonly");
    const rows = await request<ModelTurnRecord[]>(
      tx.objectStore("modelTurns").index("conversationId").getAll(conversationId),
    );
    await transactionDone(tx);
    return rows
      .map((row) => modelTurnRecordSchema.parse(row))
      .sort((left, right) => left.createdAt - right.createdAt || left.turn - right.turn);
  }

  async putModelTurn(turn: ModelTurnRecord): Promise<void> {
    await this.put("modelTurns", modelTurnRecordSchema.parse(turn));
  }

  async putRun(run: RunRecord): Promise<void> {
    await this.put("runs", runRecordSchema.parse(run));
  }

  async getRun(id: string): Promise<RunRecord | null> {
    const db = await this.open();
    const tx = db.transaction("runs", "readonly");
    const row = await request<RunRecord | undefined>(tx.objectStore("runs").get(id));
    await transactionDone(tx);
    return row ? runRecordSchema.parse(row) : null;
  }

  async getActiveRun(): Promise<RunRecord | null> {
    const rows = await this.getAll<RunRecord>("runs");
    const active = rows
      .map((row) => runRecordSchema.parse(row))
      .filter((row) => !["completed", "failed", "cancelled", "interrupted"].includes(row.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return active ?? null;
  }

  async interruptActiveRuns(): Promise<void> {
    const rows = await this.getAll<RunRecord>("runs");
    for (const row of rows.map((entry) => runRecordSchema.parse(entry))) {
      if (!["completed", "failed", "cancelled", "interrupted"].includes(row.status)) {
        await this.putRun({
          ...row,
          status: "interrupted",
          error: "Background context restarted",
          updatedAt: Date.now(),
        });
      }
    }
  }

  async listNotes(workspaceId: string): Promise<WorkspaceNote[]> {
    const db = await this.open();
    const tx = db.transaction("notes", "readonly");
    const rows = await request<WorkspaceNote[]>(
      tx.objectStore("notes").index("workspaceId").getAll(workspaceId),
    );
    await transactionDone(tx);
    return rows.map((row) => workspaceNoteSchema.parse(row)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async putNote(note: WorkspaceNote): Promise<void> {
    await this.put("notes", workspaceNoteSchema.parse(note));
  }

  async deleteNote(id: string): Promise<void> {
    const db = await this.open();
    const tx = db.transaction("notes", "readwrite");
    tx.objectStore("notes").delete(id);
    await transactionDone(tx);
  }

  async listUsage(runId?: string): Promise<TokenUsage[]> {
    const rows = (await this.getAll<TokenUsage>("usage")).map((row) => tokenUsageSchema.parse(row));
    return rows.filter((row) => !runId || row.runId === runId).sort((a, b) => a.createdAt - b.createdAt);
  }

  async putUsage(usage: TokenUsage): Promise<void> {
    await this.put("usage", tokenUsageSchema.parse(usage));
  }

  async putPromptPlan(plan: PromptPlan): Promise<void> {
    await this.put("promptPlans", promptPlanSchema.parse(plan));
  }

  async putAction(action: ActionRecord): Promise<void> {
    await this.put("actions", actionRecordSchema.parse(action));
  }

  async listActions(runId?: string): Promise<ActionRecord[]> {
    const rows = (await this.getAll<ActionRecord>("actions")).map((row) => actionRecordSchema.parse(row));
    return rows.filter((row) => !runId || row.runId === runId).sort((a, b) => a.createdAt - b.createdAt);
  }

  private async put(store: StoreName, value: unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(store, "readwrite");
    tx.objectStore(store).put(value);
    await transactionDone(tx);
  }

  private async getAll<T>(store: StoreName): Promise<T[]> {
    const db = await this.open();
    const tx = db.transaction(store, "readonly");
    const rows = await request<T[]>(tx.objectStore(store).getAll());
    await transactionDone(tx);
    return rows;
  }
}
