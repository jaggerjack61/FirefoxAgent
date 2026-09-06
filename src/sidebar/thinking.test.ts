import { describe, expect, it } from "vitest";
import type { ModelTurnRecord, ToolName } from "@/shared/schema";
import { groupThinking } from "./thinking";

function turn(
  n: number,
  tools: ToolName[] = [],
  actionsStarted?: ToolName[],
  content = `turn ${n}`,
): ModelTurnRecord {
  return {
    id: `t${n}`,
    conversationId: "c",
    runId: "r",
    turn: n,
    content,
    tools,
    ...(actionsStarted === undefined ? {} : { actionsStarted }),
    status: "completed",
    createdAt: n,
  };
}

describe("groupThinking", () => {
  it("merges consecutive turns until a mutation is dispatched", () => {
    const groups = groupThinking(
      [turn(0, ["read_page"], []), turn(1, ["click"], ["click"]), turn(2, ["fill"], [])],
      null,
    );
    expect(groups).toHaveLength(2);
    expect(groups[0]?.contents).toEqual(["turn 0", "turn 1"]);
    expect(groups[1]?.contents).toEqual(["turn 2"]);
  });

  it("does not merge across read-only results either when no mutation ran", () => {
    const groups = groupThinking([turn(0, ["read_page"], []), turn(1, ["list_tabs"], [])], null);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.tools).toEqual(["read_page", "list_tabs"]);
  });

  it("treats legacy records with tools as boundaries conservatively", () => {
    const groups = groupThinking([turn(0, ["click"]), turn(1)], null);
    expect(groups).toHaveLength(2);
  });

  it("appends the active stream to the open group or starts one after an action", () => {
    const open = groupThinking([turn(0, [], [])], { runId: "r", turn: 1, text: "live" });
    expect(open).toHaveLength(1);
    expect(open[0]?.working).toBe(true);
    expect(open[0]?.contents).toEqual(["turn 0", "live"]);

    const afterAction = groupThinking([turn(0, ["fill"], ["fill"])], { runId: "r", turn: 1, text: "live" });
    expect(afterAction).toHaveLength(2);
    expect(afterAction[1]?.working).toBe(true);
  });

  it("drops a stream whose turn is already persisted, avoiding duplicates", () => {
    const groups = groupThinking([turn(0, [], [])], { runId: "r", turn: 0, text: "live" });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.contents).toEqual(["turn 0"]);
    expect(groups[0]?.working).toBe(false);
  });

  it("creates a standalone active group when nothing is persisted yet", () => {
    const groups = groupThinking([], { runId: "r", turn: 0, text: "" });
    expect(groups).toEqual([expect.objectContaining({ working: true, contents: [], failed: false })]);
  });
});
