/**
 * TaskManager: explicit multi-step task state. Tasks survive tab switches
 * and (via IndexedDB) sidebar reopenings.
 */

import type { AgentTask, TaskStatus } from "@/shared/types";
import { newId } from "@/shared/id";
import type { MemoryStore, TaskRecord } from "@/memory/MemoryStore";

export class TaskManager {
  private task: AgentTask | null = null;

  constructor(private readonly storage: MemoryStore) {}

  getTask(): AgentTask | null {
    return this.task;
  }

  async load(id: string): Promise<AgentTask | null> {
    const rec = await this.storage.loadTask(id);
    if (!rec) return null;
    this.task = {
      id: rec.id,
      goal: rec.goal,
      status: rec.status as TaskStatus,
      referencedTabIds: [],
      completedSteps: [],
      pendingSteps: [],
      importantFacts: [],
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      ...(rec.data as Partial<AgentTask>),
    };
    return this.task;
  }

  async start(goal: string): Promise<AgentTask> {
    const now = Date.now();
    this.task = {
      id: newId("task"),
      goal,
      status: "planning",
      referencedTabIds: [],
      completedSteps: [],
      pendingSteps: [{ id: newId("step"), description: goal, status: "pending" }],
      importantFacts: [],
      createdAt: now,
      updatedAt: now,
    };
    await this.persist();
    return this.task;
  }

  async setStatus(status: TaskStatus, error?: string): Promise<void> {
    if (!this.task) return;
    this.task.status = status;
    if (error) this.task.error = error;
    this.task.updatedAt = Date.now();
    await this.persist();
  }

  async addCompletedStep(description: string): Promise<void> {
    if (!this.task) return;
    this.task.completedSteps.push({ id: newId("step"), description, status: "done" });
    this.task.updatedAt = Date.now();
    await this.persist();
  }

  async addPendingStep(description: string): Promise<void> {
    if (!this.task) return;
    this.task.pendingSteps.push({ id: newId("step"), description, status: "pending" });
    this.task.updatedAt = Date.now();
    await this.persist();
  }

  async markPendingStepDone(description: string): Promise<void> {
    if (!this.task) return;
    const idx = this.task.pendingSteps.findIndex((s) => s.description === description);
    if (idx !== -1) {
      const [step] = this.task.pendingSteps.splice(idx, 1);
      this.task.completedSteps.push({ ...step, status: "done" });
    }
    this.task.updatedAt = Date.now();
    await this.persist();
  }

  async addFact(text: string, category?: string): Promise<void> {
    if (!this.task) return;
    if (!this.task.importantFacts.some((f) => f.text === text)) {
      this.task.importantFacts.push({ id: newId("fact"), text, category, createdAt: Date.now() });
    }
    this.task.updatedAt = Date.now();
    await this.persist();
  }

  async addReferencedTab(tabId: number): Promise<void> {
    if (!this.task) return;
    if (!this.task.referencedTabIds.includes(tabId)) {
      this.task.referencedTabIds.push(tabId);
      this.task.updatedAt = Date.now();
      await this.persist();
    }
  }

  async clear(): Promise<void> {
    this.task = null;
  }

  /** Renders task context for the model. */
  renderForModel(): string {
    if (!this.task) return "TASK: (none)";
    const lines = [
      `TASK: ${this.task.goal}`,
      `STATUS: ${this.task.status}`,
      `REFERENCED TABS: ${this.task.referencedTabIds.length ? this.task.referencedTabIds.join(", ") : "(none)"}`,
    ];
    if (this.task.completedSteps.length) {
      lines.push("COMPLETED:");
      for (const s of this.task.completedSteps.slice(-15)) lines.push(`- ${s.description}`);
    }
    if (this.task.pendingSteps.length) {
      lines.push("PENDING:");
      for (const s of this.task.pendingSteps) lines.push(`- ${s.description}`);
    }
    if (this.task.importantFacts.length) {
      lines.push("TASK FACTS:");
      for (const f of this.task.importantFacts.slice(-20)) lines.push(`- ${f.text}`);
    }
    return lines.join("\n");
  }

  private async persist(): Promise<void> {
    if (!this.task) return;
    const rec: TaskRecord = {
      id: this.task.id,
      goal: this.task.goal,
      status: this.task.status,
      data: {
        referencedTabIds: this.task.referencedTabIds,
        completedSteps: this.task.completedSteps,
        pendingSteps: this.task.pendingSteps,
        importantFacts: this.task.importantFacts,
        pendingConfirmationId: this.task.pendingConfirmationId,
        error: this.task.error,
      },
      createdAt: this.task.createdAt,
      updatedAt: this.task.updatedAt,
    };
    await this.storage.saveTask(rec);
  }
}
