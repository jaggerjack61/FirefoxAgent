import "fake-indexeddb/auto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeActionIntent } from "@/security/policy";
import type { RunRecord } from "@/shared/schema";
import { IndexedDbRepository } from "./repository";

const repository = new IndexedDbRepository();

beforeAll(async () => {
  await repository.resetLegacy();
});

describe("IndexedDbRepository", () => {
  it("atomically creates the first workspace and conversation", async () => {
    const first = await repository.bootstrap();
    const second = await repository.bootstrap();
    expect(first.workspace.conversationId).toBe(first.conversation.id);
    expect(first.conversation.workspaceId).toBe(first.workspace.id);
    expect(second).toEqual(first);
  });

  it("marks unfinished runs interrupted after a background restart", async () => {
    const { workspace } = await repository.bootstrap();
    const now = Date.now();
    const run: RunRecord = {
      id: "restart-run",
      workspaceId: workspace.id,
      conversationId: workspace.conversationId,
      userMessageId: "message-1",
      status: "executing",
      mode: "agent",
      sequence: 4,
      turnCount: 2,
      actionCount: 1,
      estimatedTokens: 100,
      actualTokens: 90,
      createdAt: now,
      updatedAt: now,
    };
    await repository.putRun(run);
    expect((await repository.getActiveRun())?.id).toBe(run.id);
    await repository.interruptActiveRuns();
    expect(await repository.getActiveRun()).toBeNull();
    expect(await repository.getRun(run.id)).toMatchObject({
      status: "interrupted",
      error: "Background context restarted",
    });
  });

  it("persists only redacted browser action arguments", async () => {
    const intent = makeActionIntent(
      "restart-run",
      "fill",
      { handle: { tabId: 1, frameId: 0, revision: 1, id: "e1" }, value: "secret value" },
      { name: "Email", kind: "control" },
    );
    const now = Date.now();
    await repository.putAction({ ...intent, status: "started", createdAt: now, updatedAt: now });
    const rows = await repository.listActions("restart-run");
    expect(rows.at(-1)?.redactedArgs.value).toBe("[redacted]");
    expect(JSON.stringify(rows)).not.toContain("secret value");
  });

  it("reads notes through the workspace index and returns only that workspace in update order", async () => {
    const note = {
      runId: "notes-run",
      title: "Note",
      content: "Workspace memory",
      sources: [],
      generated: false,
      createdAt: 1,
    };
    await repository.putNote({ ...note, id: "older", workspaceId: "notes-a", updatedAt: 2 });
    await repository.putNote({ ...note, id: "newer", workspaceId: "notes-a", updatedAt: 3 });
    await repository.putNote({ ...note, id: "unrelated", workspaceId: "notes-b", updatedAt: 4 });
    const indexedRead = vi.spyOn(IDBIndex.prototype, "getAll");

    expect((await repository.listNotes("notes-a")).map((entry) => entry.id)).toEqual(["newer", "older"]);
    expect(indexedRead).toHaveBeenCalledWith("notes-a");
    await expect(repository.listNotes("missing-workspace")).resolves.toEqual([]);
  });

  it("starts a new chat by clearing the current workspace conversation and memory", async () => {
    const { workspace } = await repository.bootstrap();
    const now = Date.now();
    const run: RunRecord = {
      id: "clear-run",
      workspaceId: workspace.id,
      conversationId: workspace.conversationId,
      userMessageId: "clear-message",
      status: "completed",
      mode: "agent",
      sequence: 1,
      turnCount: 1,
      actionCount: 0,
      estimatedTokens: 10,
      actualTokens: 10,
      createdAt: now,
      updatedAt: now,
    };
    await repository.putRun(run);
    await repository.putMessage({
      id: run.userMessageId,
      conversationId: run.conversationId,
      runId: run.id,
      sequence: 0,
      role: "user",
      content: "Remember this",
      createdAt: now,
    });
    await repository.putModelTurn({
      id: `${run.id}:model-turn:0`,
      conversationId: run.conversationId,
      runId: run.id,
      turn: 0,
      content: "Checking the page",
      tools: ["read_page"],
      status: "completed",
      createdAt: now,
    });
    await repository.putNote({
      id: "clear-note",
      workspaceId: workspace.id,
      runId: run.id,
      title: "Remembered",
      content: "Workspace memory",
      sources: [],
      generated: false,
      createdAt: now,
      updatedAt: now,
    });

    expect(await repository.listModelTurns(run.conversationId)).toHaveLength(1);
    const reset = await repository.resetCurrentWorkspace();

    expect(reset.workspace.id).toBe(workspace.id);
    expect(reset.workspace.conversationId).not.toBe(workspace.conversationId);
    await expect(repository.listMessages(run.conversationId)).resolves.toEqual([]);
    await expect(repository.listModelTurns(run.conversationId)).resolves.toEqual([]);
    await expect(repository.listNotes(workspace.id)).resolves.toEqual([]);
    await expect(repository.getRun(run.id)).resolves.toBeNull();
  });
});
