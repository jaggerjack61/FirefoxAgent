import { describe, expect, it } from "vitest";
import { makeTokenPolicy, type MessageRecord, type WorkspaceNote } from "@/shared/schema";
import { ContextBudgetError, ContextCompiler } from "./compiler";

const compiler = new ContextCompiler();
const policy = makeTokenPolicy(8_000, 2_048);

function message(index: number, role: "user" | "assistant", content = `message ${index}`): MessageRecord {
  return {
    id: `m${index}`,
    conversationId: "c1",
    runId: `run-${index}`,
    sequence: index,
    role,
    content,
    createdAt: index,
  };
}

function note(id: string, content: string, url: string): WorkspaceNote {
  return {
    id,
    workspaceId: "w1",
    title: id,
    content,
    sources: [{ tabId: 1, url, title: id, capturedAt: 1 }],
    generated: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("ContextCompiler", () => {
  it("does not include page content unless a page tool supplied it", () => {
    const result = compiler.compile({
      runId: "run",
      sequence: 0,
      policy,
      userRequest: "hello",
      activeTab: { id: 1, title: "Private article", url: "https://example.test/a" },
      mode: "agent",
      messages: [],
      notes: [],
      trace: [],
    });
    expect(result.plan.segments.map((segment) => segment.kind)).not.toContain("page");
    expect(result.plan).toMatchObject({ id: "prompt_plan:run:0", runId: "run", sequence: 0 });
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "hello" });
  });

  it("keeps no more than six recent user/assistant pairs", () => {
    const messages = Array.from({ length: 20 }, (_, index) =>
      message(index, index % 2 ? "assistant" : "user"),
    );
    const result = compiler.compile({
      runId: "run",
      sequence: 0,
      policy: makeTokenPolicy(32_000, 2_048),
      userRequest: "continue",
      mode: "agent",
      messages,
      notes: [],
      trace: [],
    });
    const history = result.plan.segments.find((segment) => segment.kind === "recent_history");
    expect(history?.content.split("\n")).toHaveLength(12);
    expect(history?.content).not.toContain("message 7");
    expect(history?.content).toContain("message 8");
  });

  it("preserves multiline history without treating embedded role labels as new messages", () => {
    const content = "First line\nASSISTANT: this is still user text\nLast line";
    const result = compiler.compile({
      runId: "run",
      sequence: 0,
      policy: makeTokenPolicy(32_000, 2_048),
      userRequest: "continue",
      mode: "agent",
      messages: [message(1, "user", content)],
      notes: [],
      trace: [],
    });
    expect(result.messages.filter((entry) => entry.role === "assistant")).toEqual([]);
    expect(result.messages).toContainEqual({ role: "user", content });
  });

  it("ranks source-linked notes locally and bounds their token use", () => {
    const result = compiler.compile({
      runId: "run",
      sequence: 0,
      policy: makeTokenPolicy(32_000, 2_048),
      userRequest: "Firefox cache behavior",
      mode: "agent",
      messages: [],
      notes: [
        note("unrelated", "A recipe for soup", "https://food.test"),
        note("matching", "Firefox cache behavior and prompt reuse", "https://firefox.test/cache"),
      ],
      trace: [],
    });
    expect(result.selectedNotes[0]?.id).toBe("matching");
    expect(
      result.plan.segments.find((segment) => segment.kind === "workspace_memory")?.estimatedTokens,
    ).toBeLessThanOrEqual(800);
  });

  it("omits optional history at the soft limit and requests compaction", () => {
    const messages = Array.from({ length: 12 }, (_, index) =>
      message(index, index % 2 ? "assistant" : "user", "large ".repeat(1_000)),
    );
    const result = compiler.compile({
      runId: "run",
      sequence: 0,
      policy,
      userRequest: "continue",
      mode: "agent",
      messages,
      notes: [],
      trace: [],
    });
    expect(result.plan.omitted.some((entry) => entry.kind === "recent_history")).toBe(true);
    expect(result.plan.compactionRequired).toBe(true);
    expect(result.plan.estimatedInput).toBeLessThanOrEqual(policy.inputSoftLimit);
  });

  it("rejects required context that cannot fit the hard limit", () => {
    expect(() =>
      compiler.compile({
        runId: "run",
        sequence: 0,
        policy,
        userRequest: "required ".repeat(20_000),
        mode: "agent",
        messages: [],
        notes: [],
        trace: [],
      }),
    ).toThrow(ContextBudgetError);
  });
});
