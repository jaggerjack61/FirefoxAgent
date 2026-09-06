import { describe, expect, it } from "vitest";
import { pageSnapshotSchema } from "@/shared/schema";
import { estimateTokens, stableStringify } from "@/shared/token";
import { paginateSnapshot, splitPassage, type SnapshotItem } from "./snapshot";

const metadata = {
  tabId: 1,
  frameId: 0,
  revision: 1,
  url: "https://example.test",
  title: "Example",
  query: "save",
  warnings: [],
};
const items: SnapshotItem[] = Array.from({ length: 160 }, (_, index) => ({
  score: 0,
  element: {
    handle: { tabId: 1, frameId: 0, revision: 1, id: `doc:e${index}` },
    role: "button",
    name: `Save ${index}`,
    state: {},
  },
}));

describe("budgeted page snapshots", () => {
  it("paginates ALL controls, with complete JSON and a measured total budget", () => {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const snapshot = paginateSnapshot(metadata, items, cursor, 400);
      expect(pageSnapshotSchema.parse(JSON.parse(stableStringify(snapshot)))).toEqual(snapshot);
      expect(estimateTokens(stableStringify(snapshot))).toBe(snapshot.estimatedTokens);
      expect(snapshot.estimatedTokens).toBeLessThanOrEqual(400);
      ids.push(...snapshot.elements.map((element) => element.handle.id));
      cursor = snapshot.nextCursor;
    } while (cursor);
    expect(ids).toHaveLength(160);
    expect(new Set(ids).size).toBe(160);
  });

  it("rejects changed queries, changed targets, and malformed cursors", () => {
    const cursor = paginateSnapshot(metadata, items, null, 400).nextCursor;
    expect(() => paginateSnapshot({ ...metadata, query: "delete" }, items, cursor, 400)).toThrow(
      "STALE_CURSOR",
    );
    expect(() => paginateSnapshot(metadata, items.slice(1), cursor, 400)).toThrow("STALE_CURSOR");
    expect(() => paginateSnapshot(metadata, items, "-1", 400)).toThrow();
    expect(() => paginateSnapshot(metadata, items, "2", 400)).toThrow();
  });

  it("tolerates unrelated revision changes without resetting pagination", () => {
    const cursor = paginateSnapshot(metadata, items, null, 400).nextCursor;
    const next = items.map((item) =>
      "element" in item
        ? { ...item, element: { ...item.element, handle: { ...item.element.handle, revision: 2 } } }
        : item,
    );
    expect(paginateSnapshot({ ...metadata, revision: 2 }, next, cursor, 400).elements.length).toBeGreaterThan(
      0,
    );
  });

  it("does not lose or corrupt long multilingual passages", () => {
    const text = "Long paragraph 中文 😀\n".repeat(1000);
    const chunks = splitPassage(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => estimateTokens(chunk) <= 160)).toBe(true);
    expect(chunks.join("")).not.toContain("�");
  });

  it("reports insufficient budgets instead of skipping an item or truncating handles", () => {
    expect(() =>
      paginateSnapshot(
        metadata,
        [{ score: 0, block: { id: "large", kind: "text", text: "large ".repeat(100), score: 0 } }],
        null,
        100,
      ),
    ).toThrow("Increase maxTokens");
    expect(() => paginateSnapshot({ ...metadata, title: "large".repeat(1000) }, [], null, 100)).toThrow(
      "metadata",
    );
  });
});
