import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FirefoxGateway } from "./firefoxGateway";

const handle = { tabId: 7, frameId: 0, revision: 1, id: "e1" };
const sendMessage = vi.fn();
const executeScript = vi.fn();
const gateway = new FirefoxGateway();

beforeEach(() => {
  vi.stubGlobal("browser", {
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 7, url: "https://example.test" }),
      sendMessage,
    },
    scripting: { executeScript },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("FirefoxGateway content delivery", () => {
  it("cancels an in-flight act operation in the content script on abort", async () => {
    let resolveAct!: (value: unknown) => void;
    sendMessage.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveAct = resolve;
        }),
    );
    sendMessage.mockResolvedValueOnce({ cancelled: true });
    const controller = new AbortController();
    const pending = gateway.execute("click", { handle }, controller.signal);
    // Let the message dispatch first: pre-dispatch aborts must send nothing at all.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    const cancel = sendMessage.mock.calls[1] as unknown[];
    expect(cancel[0]).toBe(7);
    expect((cancel[1] as { type: string; operationId: string }).type).toBe("cancel_operation");
    expect((cancel[1] as { operationId: string }).operationId).toBe(
      (sendMessage.mock.calls[0]?.[1] as { operationId: string }).operationId,
    );
    // Late page responses after cancellation are inert.
    resolveAct({ status: "succeeded" });
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("routes scoped page reads to the selected frame", async () => {
    sendMessage.mockResolvedValueOnce({
      tabId: 7,
      frameId: 3,
      revision: 1,
      url: "https://example.test/frame",
      title: "Frame",
      query: "Save",
      blocks: [],
      elements: [],
      nextCursor: null,
      estimatedTokens: 50,
      warnings: [],
    });
    await gateway.execute("read_page", {
      tabId: 7,
      frameId: 3,
      query: "Save",
      mode: "controls",
      maxTokens: 900,
    });
    expect(sendMessage).toHaveBeenCalledWith(7, expect.objectContaining({ frameId: 3, mode: "controls" }), {
      frameId: 3,
    });
  });

  it("discovers frame IDs using a fixed script without model-supplied JavaScript", async () => {
    executeScript.mockResolvedValueOnce([
      { frameId: 0, result: { url: "https://example.test", title: "Main" } },
      { frameId: 3, result: { url: "https://example.test/frame", title: "Frame" } },
    ]);
    const result = await gateway.execute("list_frames", { tabId: 7 });
    expect(result.output.frames).toEqual([
      { frameId: 0, url: "https://example.test", title: "Main" },
      { frameId: 3, url: "https://example.test/frame", title: "Frame" },
    ]);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 7, allFrames: true }, func: expect.any(Function) }),
    );
  });

  it("injects and retries when no content script received the command", async () => {
    sendMessage
      .mockRejectedValueOnce(new Error("Could not establish connection. Receiving end does not exist."))
      .mockResolvedValueOnce({ status: "succeeded" });

    await expect(gateway.execute("click", { handle })).resolves.toEqual({
      output: { status: "succeeded" },
    });
    expect(executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1]).toEqual(sendMessage.mock.calls[0]);
  });

  it.each(["STALE_HANDLE", "Page handler failed after submission", "Message port closed"])(
    "does not replay an action after %s",
    async (message) => {
      const error = new Error(message);
      sendMessage.mockRejectedValueOnce(error);

      await expect(gateway.execute("submit", { handle })).rejects.toBe(error);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(executeScript).not.toHaveBeenCalled();
    },
  );

  it("does not repeatedly inject when delivery still fails", async () => {
    const error = new Error("Could not establish connection. Receiving end does not exist.");
    sendMessage.mockRejectedValue(error);

    await expect(gateway.describe(handle)).rejects.toBe(error);
    expect(executeScript).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});
