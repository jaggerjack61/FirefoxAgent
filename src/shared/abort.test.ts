import { describe, expect, it, vi } from "vitest";
import { abortable, abortableDelay } from "./abort";

describe("abortable", () => {
  it("rejects promptly even when the operation never settles, and swallows its late result", async () => {
    const controller = new AbortController();
    let settled = false;
    const pending = abortable(
      controller.signal,
      () =>
        new Promise<string>((resolve) =>
          setTimeout(() => {
            settled = true;
            resolve("late");
          }, 5_000),
        ),
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(settled).toBe(false);
  });

  it("resolves with the operation result when not aborted", async () => {
    await expect(abortable(new AbortController().signal, async () => 42)).resolves.toBe(42);
    await expect(abortable(undefined, async () => "no signal")).resolves.toBe("no signal");
  });

  it("rejects pre-aborted signals without starting the operation", async () => {
    const controller = new AbortController();
    controller.abort();
    const operation = vi.fn(async () => 1);
    await expect(abortable(controller.signal, operation)).rejects.toMatchObject({ name: "AbortError" });
    expect(operation).not.toHaveBeenCalled();
  });

  it("prefers the abort reason, keeping timeout failures distinguishable", async () => {
    const controller = new AbortController();
    const reason = new Error("The run reached its time limit");
    const pending = abortable(controller.signal, () => new Promise(() => undefined));
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it("aborts delays", async () => {
    const controller = new AbortController();
    const delay = abortableDelay(10_000, controller.signal);
    controller.abort();
    await expect(delay).rejects.toMatchObject({ name: "AbortError" });
  });
});
