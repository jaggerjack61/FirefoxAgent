import { describe, expect, it } from "vitest";
import {
  assertWebUrl,
  classifyAction,
  makeActionIntent,
  redactActionInput,
  requiresConfirmation,
} from "./policy";

describe("browser action policy", () => {
  it("classifies target-specific clicks", () => {
    expect(classifyAction("click", { kind: "navigation" })).toBe("navigation");
    expect(classifyAction("click", { kind: "control" })).toBe("submission");
    expect(classifyAction("click", { kind: "unknown" })).toBe("unknown");
    expect(classifyAction("submit")).toBe("submission");
    expect(classifyAction("close_tab")).toBe("destructive");
    expect(classifyAction("fill")).toBe("reversible");
    expect(classifyAction("activate_tab")).toBe("navigation");
    expect(classifyAction("read_page")).toBe("read");
  });

  it("enforces each safety mode", () => {
    expect(requiresConfirmation("interactive", "navigation")).toBe(true);
    expect(requiresConfirmation("interactive", "read")).toBe(false);
    expect(requiresConfirmation("agent", "reversible")).toBe(false);
    expect(requiresConfirmation("agent", "submission")).toBe(true);
    expect(requiresConfirmation("agent", "destructive")).toBe(true);
    expect(requiresConfirmation("yolo", "destructive")).toBe(false);
  });

  it("redacts form values before persistence", () => {
    const handle = { tabId: 3, frameId: 0, revision: 2, id: "e1" };
    const intent = makeActionIntent(
      "run1",
      "fill",
      { handle, value: "private" },
      { name: "Email", kind: "control" },
    );
    expect(intent.redactedArgs).toEqual({ handle, value: "[redacted]" });
    expect(intent.tabId).toBe(3);
    expect(redactActionInput({ apiKey: "a", token: "b", query: "safe" })).toEqual({
      apiKey: "[redacted]",
      token: "[redacted]",
      query: "safe",
    });
  });

  it("rejects privileged and executable URLs", () => {
    expect(assertWebUrl("https://example.test/path")).toBe("https://example.test/path");
    for (const url of [
      "about:config",
      "file:///tmp/a",
      "data:text/html,a",
      "javascript:alert(1)",
      "moz-extension://id/a",
    ]) {
      expect(() => assertWebUrl(url)).toThrow("Only HTTP(S)");
    }
  });
});
