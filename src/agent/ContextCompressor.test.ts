import { describe, it, expect } from "vitest";
import { compressConversation, compressWorkspace, preserveTaskEssence } from "./ContextCompressor";
import type { LLMMessage, WorkspaceTab } from "@/shared/types";

describe("compressConversation", () => {
  it("keeps short conversations untouched", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = compressConversation({ messages, keepRecent: 4 });
    expect(result.messages).toBe(messages);
    expect(result.droppedCount).toBe(0);
  });

  it("summarizes older messages and keeps recent ones verbatim", () => {
    const messages: LLMMessage[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push({ role: "user", content: `question ${i}` });
      messages.push({ role: "assistant", content: `answer ${i}` });
      messages.push({ role: "tool", content: `{large raw observation ${i}}` });
    }
    const result = compressConversation({ messages, keepRecent: 4 });
    expect(result.messages.length).toBeLessThan(messages.length);
    expect(result.messages[0].content).toContain("[Earlier conversation, summarized]");
    expect(result.messages[0].content).toContain("question 0");
    // Recent messages kept verbatim.
    const recentUser = result.messages.find((m) => m.role === "user" && m.content === "question 11");
    expect(recentUser).toBeDefined();
    // Raw observations dropped from the summary.
    expect(result.droppedCount).toBeGreaterThan(0);
  });
});

describe("compressWorkspace", () => {
  const makeTab = (overrides: Partial<WorkspaceTab> = {}): WorkspaceTab => ({
    tabId: 1,
    url: "https://x.test",
    title: "Tab",
    pinned: false,
    importantFacts: [],
    extractedEntities: ["entity-a", "entity-b"],
    ...overrides,
  });

  it("keeps summaries and facts, drops entities", () => {
    const tabs = [
      makeTab({
        importantFacts: [
          { id: "1", text: "$1,499", category: "price", createdAt: 1 },
          { id: "2", text: "32GB", category: "spec", createdAt: 2 },
        ],
      }),
    ];
    const result = compressWorkspace({ tabs });
    expect(result.tabs[0].importantFacts).toHaveLength(2);
    expect(result.tabs[0].extractedEntities).toEqual([]);
  });

  it("drops stale facts not in keep categories", () => {
    const tabs = [
      makeTab({
        importantFacts: [
          { id: "1", text: "old price", category: "price", createdAt: 1, stale: true },
          { id: "2", text: "old note", category: "misc", createdAt: 2, stale: true },
        ],
      }),
    ];
    const result = compressWorkspace({ tabs });
    expect(result.tabs[0].importantFacts.map((f) => f.text)).toEqual(["old price"]);
  });
});

describe("preserveTaskEssence", () => {
  it("preserves goal, steps and facts", () => {
    const text = preserveTaskEssence(
      "Compare the three laptops",
      [{ id: "1", text: "Lenovo: $1499", createdAt: 1 }],
      ["Inspected Lenovo", "Inspected Dell"],
    );
    expect(text).toContain("TASK: Compare the three laptops");
    expect(text).toContain("Inspected Lenovo");
    expect(text).toContain("Lenovo: $1499");
  });
});
