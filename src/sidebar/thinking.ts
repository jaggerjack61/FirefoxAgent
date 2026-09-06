import type { ModelTurnRecord, ToolName } from "@/shared/schema";

export interface ActiveStreamLike {
  runId: string;
  turn: number;
  text: string;
}

export interface ThinkingGroup {
  key: string;
  contents: string[];
  tools: ToolName[];
  failed: boolean;
  working: boolean;
  /** The last turn in this group dispatched a browser mutation. */
  boundary: boolean;
}

/**
 * Consecutive thinking turns render as one disclosure. A new block starts only
 * after a turn that actually dispatched a mutation (fill/click/submit…), so
 * pure reasoning and read-only steps stay collapsed together.
 *
 * Legacy records lack `actionsStarted`; treat any persisted tool call as a
 * boundary there, since we cannot prove no action was dispatched.
 */
export function groupThinking(turns: ModelTurnRecord[], stream: ActiveStreamLike | null): ThinkingGroup[] {
  const groups: ThinkingGroup[] = [];
  for (const turn of [...turns].sort((a, b) => a.turn - b.turn)) {
    let group = groups.at(-1);
    if (!group || group.boundary) {
      group = { key: turn.id, contents: [], tools: [], failed: false, working: false, boundary: false };
      groups.push(group);
    }
    if (turn.content) group.contents.push(turn.content);
    group.tools.push(...turn.tools);
    if (turn.status === "failed") group.failed = true;
    group.boundary = turn.actionsStarted ? turn.actionsStarted.length > 0 : turn.tools.length > 0;
  }
  if (stream && !turns.some((turn) => turn.turn === stream.turn)) {
    const group = groups.at(-1);
    if (group && !group.boundary) {
      group.working = true;
      if (stream.text) group.contents.push(stream.text);
    } else {
      groups.push({
        key: `active:${stream.runId}:${stream.turn}`,
        contents: stream.text ? [stream.text] : [],
        tools: [],
        failed: false,
        working: true,
        boundary: false,
      });
    }
  }
  return groups;
}
