import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IndexedDbRepository } from "@/persistence/repository";
import * as providers from "@/providers";
import type { ProviderTurnResult } from "@/providers/types";
import { SettingsRepository } from "@/settings/repository";
import { appSettingsSchema, DEFAULT_SETTINGS, type ToolCall } from "@/shared/schema";
import { providerRequest } from "@/test/providerFixture";
import { FirefoxGateway } from "./firefoxGateway";
import { Orchestrator } from "./orchestrator";

const repository = new IndexedDbRepository();
const handle = { tabId: 7, frameId: 0, revision: 1, id: "e1" };

function result(toolCalls: ToolCall[] = []): ProviderTurnResult {
  return {
    text: toolCalls.length ? "Using the browser" : "Done",
    toolCalls,
    incomplete: false,
    usage: {
      input: 10,
      cachedInput: 0,
      cacheWrite: 0,
      output: 10,
      reasoning: 0,
      total: 20,
      estimated: false,
    },
  };
}

async function setup(call?: ToolCall) {
  const gateway = new FirefoxGateway();
  vi.spyOn(gateway, "registerContentScript").mockResolvedValue();
  vi.spyOn(gateway, "hasSiteAccess").mockResolvedValue(true);
  vi.spyOn(gateway, "activeTab").mockResolvedValue(undefined);
  vi.spyOn(gateway, "describe").mockResolvedValue({ name: "Control", kind: "control" });
  vi.spyOn(gateway, "execute").mockResolvedValue({ output: { status: "succeeded" } });
  vi.spyOn(SettingsRepository.prototype, "load").mockResolvedValue({
    ...DEFAULT_SETTINGS,
    provider: providerRequest().settings,
  });
  const stream = vi.fn().mockResolvedValue(result());
  if (call) stream.mockResolvedValueOnce(result([call]));
  vi.spyOn(providers, "createProvider").mockReturnValue({ stream });
  const orchestrator = new Orchestrator(repository, gateway);
  await orchestrator.init();
  return { orchestrator, gateway, stream };
}

async function start(orchestrator: Orchestrator) {
  return (await orchestrator.handle({
    version: 1,
    requestId: "start",
    type: "send_message",
    text: "Use the browser",
  })) as { runId: string };
}

async function stop(orchestrator: Orchestrator) {
  await orchestrator.handle({ version: 1, requestId: "stop", type: "stop_run" });
}

async function expectStatus(runId: string, status: string) {
  await vi.waitFor(async () => {
    expect(await repository.getRun(runId)).toMatchObject({ status });
  });
}

beforeEach(async () => {
  await repository.resetCurrentWorkspace();
});

describe("Orchestrator action lifecycle", () => {
  it("switches profiles explicitly, preserves separate credentials, and refuses mid-run changes", async () => {
    const { orchestrator, stream } = await setup();
    vi.spyOn(SettingsRepository.prototype, "save").mockResolvedValue();
    const settings = appSettingsSchema.parse({
      providers: [
        { id: "a", name: "Personal", settings: providerRequest().settings },
        {
          id: "b",
          name: "Work",
          settings: { ...providerRequest().settings, apiKey: "work-key", model: "work-model" },
        },
      ],
      activeProviderId: "a",
    });
    await orchestrator.handle({ version: 1, requestId: "save", type: "save_settings", settings });
    await orchestrator.handle({ version: 1, requestId: "switch", type: "set_provider", providerId: "b" });
    await orchestrator.handle({ version: 1, requestId: "model", type: "set_model", model: "new-work-model" });
    expect(await orchestrator.handle({ version: 1, requestId: "state", type: "get_state" })).toMatchObject({
      settings: {
        activeProviderId: "b",
        provider: { apiKey: "work-key", model: "new-work-model" },
        providers: [
          { id: "a", settings: { apiKey: "secret", model: "test-model" } },
          { id: "b", settings: { apiKey: "work-key", model: "new-work-model" } },
        ],
      },
    });
    stream.mockImplementationOnce(async () => {
      await expect(
        orchestrator.handle({ version: 1, requestId: "switch", type: "set_provider", providerId: "a" }),
      ).rejects.toThrow("active");
      return result();
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "completed");
    expect(stream.mock.calls[0]?.[0].settings.apiKey).toBe("work-key");
  });

  it("does not execute tool calls from an incomplete generation", async () => {
    const { orchestrator, stream, gateway } = await setup();
    stream.mockResolvedValueOnce({
      ...result([{ id: "a", name: "fill", arguments: { handle, value: "partial" } }]),
      incomplete: true,
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "failed");
    expect(gateway.execute).not.toHaveBeenCalled();
  });

  it("records timed-out waits as failed actions, not successful observations", async () => {
    const { orchestrator, gateway } = await setup({
      id: "wait",
      name: "wait_for",
      arguments: { tabId: 1, condition: "Ready" },
    });
    vi.mocked(gateway.execute).mockResolvedValueOnce({ output: { matched: false, reason: "timeout" } });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "completed");
    expect((await repository.listActions(runId))[0]?.status).toBe("failed");
  });

  it("persists failed actions and lets the model recover without persisting private errors", async () => {
    const { orchestrator, gateway, stream } = await setup({
      id: "call-1",
      name: "fill",
      arguments: { handle, value: "private value" },
    });
    vi.mocked(gateway.execute).mockRejectedValueOnce(new Error("Rejected private value"));
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "completed");

    const actions = await repository.listActions(runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ status: "failed", redactedArgs: { value: "[redacted]" } });
    expect(JSON.stringify(actions)).not.toContain("private value");
    expect(stream.mock.calls[1]?.[0].steps[0].toolResults[0].output).toContain('"status":"failed"');
  });

  it("does not execute when stopped while describing a target", async () => {
    const { orchestrator, gateway } = await setup({
      id: "call-1",
      name: "fill",
      arguments: { handle, value: "hello" },
    });
    vi.mocked(gateway.describe).mockImplementationOnce(async () => {
      await stop(orchestrator);
      return { kind: "control" };
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "cancelled");

    expect(gateway.execute).not.toHaveBeenCalled();
    expect(await repository.listActions(runId)).toEqual([expect.objectContaining({ status: "failed" })]);
  });

  it("does not wait for confirmation if stopped before registering the abort listener", async () => {
    const { orchestrator, gateway } = await setup({
      id: "call-1",
      name: "submit",
      arguments: { handle },
    });
    vi.mocked(gateway.describe).mockImplementationOnce(async () => {
      await stop(orchestrator);
      return { kind: "control" };
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "cancelled");

    expect(gateway.execute).not.toHaveBeenCalled();
    expect(await orchestrator.handle({ version: 1, requestId: "state", type: "get_state" })).toMatchObject({
      pendingConfirmation: null,
    });
  });

  it("stops a run whose provider stream never settles and ignores its late completion", async () => {
    const { orchestrator, stream } = await setup();
    let finish!: (value: ProviderTurnResult) => void;
    stream.mockImplementationOnce(
      () =>
        new Promise<ProviderTurnResult>((resolve) => {
          finish = resolve;
        }),
    );
    const { runId } = await start(orchestrator);
    await vi.waitFor(() => {
      expect(stream).toHaveBeenCalled();
    });
    await stop(orchestrator);
    await expectStatus(runId, "cancelled");
    // A provider that ignores the abort and answers later must not resurrect the run.
    finish(result());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await repository.getRun(runId)).toMatchObject({ status: "cancelled" });
    expect(await orchestrator.handle({ version: 1, requestId: "state", type: "get_state" })).toMatchObject({
      activeRun: null,
    });
  });

  it("ignores a stop request carrying a different run id", async () => {
    const { orchestrator, stream } = await setup();
    stream.mockImplementationOnce(() => new Promise<ProviderTurnResult>(() => undefined));
    const { runId } = await start(orchestrator);
    await orchestrator.handle({
      version: 1,
      requestId: "wrong-stop",
      type: "stop_run",
      runId: "run_other",
    });
    expect(await repository.getActiveRun()).not.toBeNull();
    await stop(orchestrator);
    await expectStatus(runId, "cancelled");
  });

  it("stops a run waiting on wait_for and records the wait as failed, not unverified", async () => {
    const { orchestrator, gateway } = await setup({
      id: "wait",
      name: "wait_for",
      arguments: { tabId: 1, condition: "Ready" },
    });
    vi.mocked(gateway.execute).mockImplementationOnce(async (_name, _input, signal) => {
      await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), {
          once: true,
        });
      });
      return { output: { matched: true } };
    });
    const { runId } = await start(orchestrator);
    await vi.waitFor(async () => {
      expect(gateway.execute).toHaveBeenCalled();
    });
    await stop(orchestrator);
    await expectStatus(runId, "cancelled");
    expect((await repository.listActions(runId))[0]?.status).toBe("failed");
  });

  it("progressively records which mutations were dispatched for thinking grouping", async () => {
    const { orchestrator } = await setup({
      id: "call-1",
      name: "fill",
      arguments: { handle, value: "hello" },
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "completed");
    const workspace = await repository.getWorkspace();
    const turns = await repository.listModelTurns(workspace.conversationId);
    expect(turns).toEqual([expect.objectContaining({ tools: ["fill"], actionsStarted: ["fill"] })]);
  });

  it("does not accept a provider response that arrives after stopping", async () => {
    const { orchestrator, stream } = await setup();
    stream.mockImplementationOnce(async () => {
      await stop(orchestrator);
      return result();
    });
    const { runId } = await start(orchestrator);
    await expectStatus(runId, "cancelled");

    const workspace = await repository.getWorkspace();
    expect(await repository.listMessages(workspace.conversationId)).toEqual([
      expect.objectContaining({ role: "user" }),
    ]);
  });
});
