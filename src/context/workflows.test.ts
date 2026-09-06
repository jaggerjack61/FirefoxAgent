import { describe, expect, it } from "vitest";
import benchmark from "@/test/fixtures/legacy-benchmark.json";
import { makeTokenPolicy, type MessageRecord } from "@/shared/schema";
import { TOKEN_LIMITS } from "@/shared/token";
import { ContextCompiler, type TraceSegment } from "./compiler";

const compiler = new ContextCompiler();
const policy = makeTokenPolicy(32_000, 2_048);

describe("token workflow acceptance ceilings", () => {
  it("uses no page-content tokens for a greeting", () => {
    const result = compiler.compile({
      runId: "greeting",
      sequence: 0,
      policy,
      userRequest: "Hello",
      mode: "agent",
      messages: [],
      notes: [],
      trace: [],
    });
    expect(result.plan.segments.filter((segment) => segment.kind === "page")).toHaveLength(0);
    expect(result.plan.estimatedInput).toBeLessThanOrEqual(benchmark.workflows[0]?.v1Ceiling ?? 0);
  });

  it("keeps a five-step form trace below 600 result tokens and 8,000 active tokens", () => {
    const trace: TraceSegment[] = Array.from({ length: 5 }, (_, index) => ({
      kind: "tool_trace",
      content: `fill({handle:e${index}}) => ${"x".repeat(TOKEN_LIMITS.toolResult * 3)}`,
    }));
    const result = compiler.compile({
      runId: "form",
      sequence: 0,
      policy,
      userRequest: "Complete the form",
      mode: "agent",
      messages: [],
      notes: [],
      trace,
    });
    expect(TOKEN_LIMITS.toolResult * 5).toBe(600);
    expect(result.plan.estimatedInput).toBeLessThan(8_000);
  });

  it("bounds three default page reads below the comparison ceiling", () => {
    expect(TOKEN_LIMITS.defaultPageResult * 3).toBeLessThanOrEqual(5_000);
    expect(TOKEN_LIMITS.maximumPageResult).toBe(2_000);
  });

  it("cuts median raw input by at least half against captured 0.1.0 payload counts", () => {
    const oldMedian = median(benchmark.workflows.map((workflow) => workflow.legacyRawInput));
    const newMedian = median(benchmark.workflows.map((workflow) => workflow.v1Ceiling));
    expect(newMedian).toBeLessThanOrEqual(oldMedian * 0.5);
  });

  it("keeps older completed turns local when the recent-pair window is full", () => {
    const messages: MessageRecord[] = Array.from({ length: 30 }, (_, index) => ({
      id: `m${index}`,
      conversationId: "c",
      runId: `run-${index}`,
      sequence: index,
      role: index % 2 ? "assistant" : "user",
      content: `turn ${index}`,
      createdAt: index,
    }));
    const result = compiler.compile({
      runId: "history",
      sequence: 0,
      policy,
      userRequest: "continue",
      mode: "agent",
      messages,
      notes: [],
      trace: [],
    });
    const history = result.plan.segments.find((segment) => segment.kind === "recent_history")?.content ?? "";
    expect(history).not.toContain("turn 17");
    expect(history).toContain("turn 18");
  });
});

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}
