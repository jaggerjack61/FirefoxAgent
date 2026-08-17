import { describe, expect, it, vi } from "vitest";
import type { BackgroundEvent } from "@/shared/events";
import { bridgeBackgroundEvents } from "./eventBridge";

describe("bridgeBackgroundEvents", () => {
  it("forwards orchestrator events to extension contexts", () => {
    let listener: ((event: BackgroundEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const source = {
      subscribe: vi.fn((next: (event: BackgroundEvent) => void) => {
        listener = next;
        return unsubscribe;
      }),
    };
    const runtime = { sendMessage: vi.fn().mockResolvedValue(undefined) };
    const stop = bridgeBackgroundEvents(source, runtime);

    listener?.({ type: "STREAM_DELTA", text: "hello" });

    expect(runtime.sendMessage).toHaveBeenCalledWith({
      event: "BACKGROUND_EVENT",
      payload: { type: "STREAM_DELTA", text: "hello" },
    });
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
