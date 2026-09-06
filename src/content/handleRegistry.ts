import { createId } from "@/shared/token";
import { elementHandleSchema, type ElementHandle } from "@/shared/schema";

export interface ElementIdentity {
  tag: string;
  name: string;
  semantics?: string;
}

export const STALE_HANDLE_MESSAGE =
  "STALE_HANDLE: this element was removed or changed into something else after the snapshot. " +
  "Call read_page again and retry with the fresh handle.";

interface RegistryEntry<T> {
  element: T;
  tabId: number;
  frameId: number;
  /** Identity of the element as observed at each snapshot revision. */
  identities: Map<number, ElementIdentity>;
}

export class HandleRegistry<T extends object & { isConnected: boolean }> {
  private readonly ids = new WeakMap<T, string>();
  private readonly entries = new Map<string, RegistryEntry<T>>();
  private nextId = 1;
  revision = 1;

  constructor(
    private readonly identityOf: (element: T) => ElementIdentity = defaultIdentity,
    private readonly documentId = createId("doc"),
  ) {}

  bind(element: T, tabId: number, frameId: number): ElementHandle {
    let id = this.ids.get(element);
    if (!id) {
      id = `${this.documentId}:e${this.nextId++}`;
      this.ids.set(element, id);
    }
    const identity = this.identityOf(element);
    const existing = this.entries.get(id);
    if (existing) {
      const recorded = existing.identities.get(this.revision);
      if (recorded && !sameIdentity(identity, recorded)) this.invalidate();
      existing.element = element;
      existing.identities.set(this.revision, identity);
      if (existing.identities.size > 32) {
        const oldest = existing.identities.keys().next().value;
        if (oldest !== undefined && oldest !== this.revision) existing.identities.delete(oldest);
      }
    } else {
      this.entries.set(id, { element, tabId, frameId, identities: new Map([[this.revision, identity]]) });
    }
    return { tabId, frameId, revision: this.revision, id };
  }

  resolve(value: ElementHandle): T {
    const handle = elementHandleSchema.parse(value);
    const entry = this.entries.get(handle.id);
    if (
      !entry ||
      !entry.element.isConnected ||
      entry.tabId !== handle.tabId ||
      entry.frameId !== handle.frameId
    )
      throw new Error(STALE_HANDLE_MESSAGE);
    // The page mutated since this handle's snapshot, but if the element still
    // looks exactly like it did at that revision (same tag + accessible name),
    // the handle keeps pointing at the same thing — act on it instead of
    // failing on unrelated DOM churn. Recycled nodes that changed content or
    // role still fail closed below.
    const recorded = entry.identities.get(handle.revision);
    if (recorded && sameIdentity(this.identityOf(entry.element), recorded)) return entry.element;
    throw new Error(STALE_HANDLE_MESSAGE);
  }

  invalidate(): void {
    this.revision += 1;
    for (const [id, entry] of this.entries) if (!entry.element.isConnected) this.entries.delete(id);
    // Hard cap so long-lived tabs on churning SPAs cannot leak memory.
    if (this.entries.size > 5_000) this.entries.clear();
  }
}

function sameIdentity(left: ElementIdentity, right: ElementIdentity): boolean {
  return left.tag === right.tag && left.name === right.name && left.semantics === right.semantics;
}

function defaultIdentity(element: object & { isConnected: boolean }): ElementIdentity {
  const node = element as unknown as {
    tagName?: string;
    textContent?: string | null;
    getAttribute?: (name: string) => string | null;
  };
  const name = node.getAttribute?.("aria-label") ?? node.textContent ?? "";
  return {
    tag: node.tagName?.toLocaleLowerCase() ?? "",
    name: name.replace(/\s+/gu, " ").trim(),
    semantics: ["role", "href", "type", "name", "formaction"]
      .map((key) => node.getAttribute?.(key) ?? "")
      .join("\0"),
  };
}
