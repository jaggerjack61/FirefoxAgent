import { describe, expect, it } from "vitest";
import type { ConversationStep } from "@/providers/types";
import { pruneSupersededReads } from "./observations";

function read(id: string, args: Record<string, unknown> = {}, output?: string): ConversationStep {
  return {
    text: "",
    toolCalls: [{ id, name: "read_page", arguments: { tabId: 1, ...args } }],
    toolResults: [
      {
        callId: id,
        output: output ?? JSON.stringify({ url: "https://example.test", blocks: [], elements: [] }),
      },
    ],
  };
}

describe("observation reuse", () => {
  it("replaces earlier identical slices, retaining tool pairing", () => {
    const steps = [read("a"), read("b")];
    pruneSupersededReads(steps);
    expect(JSON.parse(steps[0]!.toolResults[0]!.output).status).toBe("superseded");
    expect(steps[0]!.toolCalls[0]!.id).toBe(steps[0]!.toolResults[0]!.callId);
    expect(JSON.parse(steps[1]!.toolResults[0]!.output).elements).toEqual([]);
  });
  it("keeps separate queries, pagination, modes, frames, and failed newer reads", () => {
    const steps = [
      read("a"),
      read("b", { cursor: "next" }),
      read("c", { query: "other" }),
      read("d", { mode: "controls" }),
      read("e", { frameId: 1 }),
      read("f", {}, '{"status":"failed"}'),
      read("g", {}, "invalid"),
    ];
    const before = JSON.stringify(steps);
    pruneSupersededReads(steps);
    expect(JSON.stringify(steps)).toBe(before);
  });
});
