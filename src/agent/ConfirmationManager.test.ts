import { describe, it, expect, vi } from "vitest";
import { ConfirmationManager } from "./ConfirmationManager";
import type { BackgroundEvent } from "@/shared/events";

function createManager() {
  const events: BackgroundEvent[] = [];
  const cm = new ConfirmationManager({ emit: (e) => events.push(e) });
  return { cm, events };
}

describe("ConfirmationManager", () => {
  it("requests confirmation and resolves on user approval", async () => {
    const { cm, events } = createManager();
    const promise = cm.request("click_element", "Click Buy now", "details", { highRisk: true });
    expect(cm.pendingRequest).not.toBeNull();
    expect(events.some((e) => e.type === "CONFIRMATION_REQUESTED")).toBe(true);

    cm.respond(cm.pendingRequest!.id, true);
    const approved = await promise;
    expect(approved).toBe(true);
    expect(cm.pendingRequest).toBeNull();
  });

  it("resolves false on rejection", async () => {
    const { cm } = createManager();
    const promise = cm.request("close_tab", "Close 5 tabs", "", { highRisk: false });
    cm.respond(cm.pendingRequest!.id, false);
    expect(await promise).toBe(false);
  });

  it("auto-expires after the TTL", async () => {
    vi.useFakeTimers();
    try {
      const { cm } = createManager();
      const promise = cm.request("click_element", "x", "", { highRisk: false });
      vi.advanceTimersByTime(6 * 60_000);
      expect(await promise).toBe(false);
      expect(cm.pendingRequest).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels pending requests on stop", async () => {
    const { cm } = createManager();
    const promise = cm.request("click_element", "x", "", { highRisk: false });
    cm.cancelAll();
    expect(await promise).toBe(false);
  });

  it("ignores responses for unknown ids", async () => {
    const { cm } = createManager();
    expect(cm.respond("nope", true)).toBe(false);
  });
});
