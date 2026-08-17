import { describe, it, expect } from "vitest";
import { TaskManager } from "./TaskManager";
import { FakeMemoryStore } from "@/test/fakes";

describe("TaskManager", () => {
  it("starts a task in planning state", async () => {
    const tm = new TaskManager(new FakeMemoryStore());
    const task = await tm.start("Compare the laptops");
    expect(task.status).toBe("planning");
    expect(task.goal).toBe("Compare the laptops");
    expect(task.pendingSteps).toHaveLength(1);
  });

  it("transitions through states", async () => {
    const tm = new TaskManager(new FakeMemoryStore());
    await tm.start("Goal");
    await tm.setStatus("running");
    expect(tm.getTask()!.status).toBe("running");
    await tm.setStatus("awaiting_user");
    expect(tm.getTask()!.status).toBe("awaiting_user");
    await tm.setStatus("completed");
    expect(tm.getTask()!.status).toBe("completed");
  });

  it("tracks completed and pending steps", async () => {
    const tm = new TaskManager(new FakeMemoryStore());
    await tm.start("Goal");
    await tm.addPendingStep("Inspect Dell");
    await tm.addCompletedStep("Inspected Lenovo");
    const task = tm.getTask()!;
    expect(task.completedSteps.map((s) => s.description)).toContain("Inspected Lenovo");
    expect(task.pendingSteps.map((s) => s.description)).toContain("Inspect Dell");

    await tm.markPendingStepDone("Inspect Dell");
    expect(tm.getTask()!.pendingSteps.some((s) => s.description === "Inspect Dell")).toBe(false);
    expect(tm.getTask()!.completedSteps.some((s) => s.description === "Inspect Dell")).toBe(true);
  });

  it("records facts without duplicates and referenced tabs", async () => {
    const tm = new TaskManager(new FakeMemoryStore());
    await tm.start("Goal");
    await tm.addFact("Lenovo: $1499");
    await tm.addFact("Lenovo: $1499");
    await tm.addFact("Dell: $1399");
    await tm.addReferencedTab(3);
    await tm.addReferencedTab(3);
    expect(tm.getTask()!.importantFacts).toHaveLength(2);
    expect(tm.getTask()!.referencedTabIds).toEqual([3]);
  });

  it("survives serialization (persistence round-trip)", async () => {
    const store = new FakeMemoryStore();
    const tm = new TaskManager(store);
    await tm.start("Persist me");
    await tm.setStatus("running");
    await tm.addFact("fact 1");
    await tm.addCompletedStep("step 1");

    const tm2 = new TaskManager(store);
    const loaded = await tm2.load(tm.getTask()!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.status).toBe("running");
    expect(loaded!.goal).toBe("Persist me");
    expect(loaded!.importantFacts.map((f) => f.text)).toContain("fact 1");
    expect(loaded!.completedSteps.map((s) => s.description)).toContain("step 1");
  });

  it("renders task context for the model", async () => {
    const tm = new TaskManager(new FakeMemoryStore());
    await tm.start("Compare the three laptops opened by the user");
    await tm.addReferencedTab(3);
    await tm.addCompletedStep("Inspected Lenovo");
    const rendered = tm.renderForModel();
    expect(rendered).toContain("TASK: Compare the three laptops opened by the user");
    expect(rendered).toContain("REFERENCED TABS: 3");
    expect(rendered).toContain("Inspected Lenovo");
  });
});
