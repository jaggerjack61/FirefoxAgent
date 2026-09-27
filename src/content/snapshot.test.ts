import { describe, expect, it } from "vitest";
import { pageSnapshotSchema, parseHandle } from "@/shared/schema";
import { estimateTokens, stableStringify } from "@/shared/token";
import { paginateSnapshot, splitPassage, type SnapshotItem } from "./snapshot";

const metadata = {
  tabId: 1,
  frameId: 0,
  url: "https://example.test",
  title: "Example",
  query: "save",
  warnings: [],
};
const items: SnapshotItem[] = Array.from({ length: 160 }, (_, index) => ({
  score: 0,
  element: { handle: `1.0.1.doc:e${index}`, role: "button", name: `Save ${index}` },
}));

describe("budgeted page snapshots", () => {
  it("paginates ALL controls, with complete JSON and a measured total budget", () => {
    let cursor: string | null = null;
    const ids: string[] = [];
    do {
      const snapshot = paginateSnapshot(metadata, items, cursor, 400);
      expect(pageSnapshotSchema.parse(JSON.parse(stableStringify(snapshot)))).toEqual(snapshot);
      expect(estimateTokens(stableStringify(snapshot))).toBeLessThanOrEqual(400);
      ids.push(...snapshot.elements.map((element) => parseHandle(element.handle).id));
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
        ? { ...item, element: { ...item.element, handle: item.element.handle.replace(".1.", ".2.") } }
        : item,
    );
    expect(paginateSnapshot(metadata, next, cursor, 400).elements.length).toBeGreaterThan(0);
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
      paginateSnapshot(metadata, [{ score: 0, block: { text: "large ".repeat(100) } }], null, 100),
    ).toThrow("Increase maxTokens");
    expect(() => paginateSnapshot({ ...metadata, title: "large".repeat(1000) }, [], null, 100)).toThrow(
      "metadata",
    );
  });

  it("keeps model-facing output compact: no ranking scores, empty state, or unused metadata", () => {
    const snapshot = paginateSnapshot(
      metadata,
      [
        { score: 1, block: { text: "Plain paragraph" } },
        { score: 0.5, block: { kind: "heading", text: "Section" } },
        items[0]!,
      ],
      null,
      400,
    );
    const json = stableStringify(snapshot);
    expect(json).not.toMatch(/"score"|"state"|"query"|"estimatedTokens"|"warnings"|"revision"/u);
    expect(snapshot.blocks).toEqual([{ text: "Plain paragraph" }, { kind: "heading", text: "Section" }]);
    expect(paginateSnapshot({ ...metadata, warnings: ["Subframes"] }, [], null, 400).warnings).toEqual([
      "Subframes",
    ]);
  });

  it("fits more than twice as many controls per read as the legacy object-handle format", () => {
    const legacy = {
      handle: { frameId: 0, id: "doc_1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed:e12", revision: 3, tabId: 12 },
      name: "Add to cart",
      role: "button",
      state: {},
    };
    const compact = { handle: "12.0.3.k3x9q:e12", name: "Add to cart", role: "button" };
    expect(parseHandle(compact.handle)).toEqual({ tabId: 12, frameId: 0, revision: 3, id: "k3x9q:e12" });
    expect(estimateTokens(stableStringify(legacy))).toBeGreaterThan(
      estimateTokens(stableStringify(compact)) * 2,
    );
  });
});
