import type { PageSnapshot, PageElement } from "@/shared/schema";
import { contentHash, estimateTokens, stableStringify } from "@/shared/token";

type Block = PageSnapshot["blocks"][number];
export type SnapshotItem = { block: Block; score: number } | { element: PageElement; score: number };
type Metadata = Omit<PageSnapshot, "blocks" | "elements" | "nextCursor" | "estimatedTokens">;

/** Budget the actual JSON, not just prose. Never cut a handle or cursor in half. */
export function paginateSnapshot(
  metadata: Metadata,
  items: SnapshotItem[],
  cursor: string | null,
  maxTokens: number,
  mode = "all",
): PageSnapshot {
  const fingerprint = contentHash(
    stableStringify({
      url: metadata.url,
      query: metadata.query,
      tabId: metadata.tabId,
      frameId: metadata.frameId,
      mode,
      items: items.map((item) =>
        "block" in item
          ? item
          : {
              ...item,
              element: { ...item.element, handle: { ...item.element.handle, revision: 0 } },
            },
      ),
    }),
  );
  let start = 0;
  if (cursor) {
    const match = /^([a-f0-9]{8}):(\d+)$/u.exec(cursor);
    if (!match || match[1] !== fingerprint)
      throw new Error("STALE_CURSOR: page or query changed. Read again without a cursor.");
    start = Number(match[2]);
    if (!Number.isSafeInteger(start) || start >= items.length) throw new Error("Invalid page cursor");
  }
  const snapshot: PageSnapshot = {
    ...metadata,
    blocks: [],
    elements: [],
    nextCursor: null,
    estimatedTokens: 0,
  };
  const measure = () => {
    // Fixed point includes the cost of the estimate itself.
    for (let count = 0; count < 3; count += 1)
      snapshot.estimatedTokens = estimateTokens(stableStringify(snapshot));
    return snapshot.estimatedTokens;
  };
  for (let index = start; index < items.length; index += 1) {
    const item = items[index]!;
    if ("block" in item) snapshot.blocks.push(item.block);
    else snapshot.elements.push(item.element);
    snapshot.nextCursor = index + 1 < items.length ? `${fingerprint}:${index + 1}` : null;
    if (measure() > maxTokens) {
      if ("block" in item) snapshot.blocks.pop();
      else snapshot.elements.pop();
      snapshot.nextCursor = `${fingerprint}:${index}`;
      if (index === start)
        throw new Error(
          "Page item exceeds this budget. Increase maxTokens (up to 2000) or narrow the query.",
        );
      break;
    }
  }
  if (measure() > maxTokens) throw new Error("Page metadata exceeds this budget. Increase maxTokens.");
  return snapshot;
}

/** Long passages remain retrievable instead of being silently discarded. */
export function splitPassage(text: string, maxTokens = 160): string[] {
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  const encoder = new TextEncoder();
  for (const char of text) {
    const cost = encoder.encode(char).length;
    if (bytes + cost > Math.floor(maxTokens * 3.2) && current) {
      parts.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += cost;
  }
  if (current) parts.push(current);
  return parts;
}
