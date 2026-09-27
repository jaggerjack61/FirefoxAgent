import { describe, expect, it } from "vitest";
import type { ConversationStep } from "@/providers/types";
import { maskStaleObservations, pruneSupersededReads } from "./observations";

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

describe("maskStaleObservations", () => {
  const page = (id: string, url: string) =>
    read(id, { query: id }, JSON.stringify({ url, blocks: [{ text: "x".repeat(3_200) }], elements: [] }));

  it("leaves a trace under the high watermark untouched", () => {
    const steps = [page("a", "https://a.test"), page("b", "https://b.test")];
    const before = JSON.stringify(steps);
    expect(maskStaleObservations(steps, 10_000, 5_000)).toBe(0);
    expect(JSON.stringify(steps)).toBe(before);
  });

  it("elides the oldest large outputs down to the low watermark and never the recent steps", () => {
    const steps = Array.from({ length: 6 }, (_, index) => page(`p${index}`, `https://site.test/${index}`));
    const masked = maskStaleObservations(steps, 3_000, 2_200, 2);
    expect(masked).toBeGreaterThan(0);
    expect(JSON.parse(steps[0]!.toolResults[0]!.output)).toMatchObject({
      status: "elided",
      url: "https://site.test/0",
    });
    for (const step of steps.slice(-2)) expect(step.toolResults[0]!.output).toContain("xxxx");
    // Batched to the low watermark: a second call with the same budget is a no-op (cache-stable).
    expect(maskStaleObservations(steps, 3_000, 2_200, 2)).toBe(0);
  });

  it("keeps small results that would not save anything", () => {
    const small: ConversationStep = {
      text: "",
      toolCalls: [{ id: "c", name: "click", arguments: {} }],
      toolResults: [{ callId: "c", output: '{"status":"succeeded"}' }],
    };
    const steps = [small, ...Array.from({ length: 4 }, (_, index) => page(`p${index}`, "https://s.test"))];
    maskStaleObservations(steps, 1_000, 10, 2);
    expect(steps[0]!.toolResults[0]!.output).toBe('{"status":"succeeded"}');
  });
});
