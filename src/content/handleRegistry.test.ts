import { describe, expect, it } from "vitest";
import { HandleRegistry, STALE_HANDLE_MESSAGE } from "./handleRegistry";

interface FakeElement {
  isConnected: boolean;
  label: string;
}

function registry(): HandleRegistry<FakeElement> {
  return new HandleRegistry<FakeElement>((element) => ({ tag: "button", name: element.label }), "test");
}

describe("HandleRegistry", () => {
  it("binds internal handles without exposing selectors", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 7, 0);
    expect(handle).toEqual({ tabId: 7, frameId: 0, revision: 1, id: "test:e1" });
    expect(handles.resolve(handle)).toBe(element);
  });

  it("tolerates stale revisions while the element keeps its identity", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 7, 0);
    handles.invalidate();
    // Unrelated DOM churn must not fail actions on an unchanged element.
    expect(handles.resolve(handle)).toBe(element);
  });

  it("rejects stale revisions when the element identity changed (recycled node)", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 7, 0);
    element.label = "Delete forever";
    handles.invalidate();
    expect(() => handles.resolve(handle)).toThrow(STALE_HANDLE_MESSAGE);
  });

  it("rejects disconnected elements with recovery guidance", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 1, 0);
    element.isConnected = false;
    expect(() => handles.resolve(handle)).toThrow(/read_page again/u);
  });

  it("rebinding at a new revision restores the fast path", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    handles.bind(element, 7, 0);
    handles.invalidate();
    element.label = "Delete forever";
    const rebound = handles.bind(element, 7, 0);
    expect(rebound.revision).toBe(2);
    expect(handles.resolve(rebound)).toBe(element);
  });

  it("rejects changed identity even before a mutation observer flush", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 7, 0);
    element.label = "Delete";
    expect(() => handles.resolve(handle)).toThrow(STALE_HANDLE_MESSAGE);
    const fresh = handles.bind(element, 7, 0);
    expect(fresh.revision).toBeGreaterThan(handle.revision);
    expect(() => handles.resolve(handle)).toThrow(STALE_HANDLE_MESSAGE);
    expect(handles.resolve(fresh)).toBe(element);
  });

  it("binds handles to their tab, frame, and document", () => {
    const handles = registry();
    const element = { isConnected: true, label: "Save" };
    const handle = handles.bind(element, 7, 0);
    expect(() => handles.resolve({ ...handle, tabId: 8 })).toThrow();
    expect(() => handles.resolve({ ...handle, frameId: 1 })).toThrow();
    const other = new HandleRegistry<FakeElement>((node) => ({ tag: "button", name: node.label }));
    other.bind(element, 7, 0);
    expect(() => other.resolve(handle)).toThrow();
  });

  it("rejects same-label links when the destination changes", () => {
    let href = "/safe";
    const handles = new HandleRegistry<FakeElement>((element) => ({
      tag: "a",
      name: element.label,
      semantics: href,
    }));
    const handle = handles.bind({ isConnected: true, label: "Continue" }, 1, 0);
    href = "/delete";
    expect(() => handles.resolve(handle)).toThrow();
  });

  it("prunes disconnected entries on invalidate without clearing live handles", () => {
    const handles = registry();
    const gone = { isConnected: true, label: "Gone" };
    const kept = { isConnected: true, label: "Kept" };
    const goneHandle = handles.bind(gone, 1, 0);
    handles.bind(kept, 1, 0);
    gone.isConnected = false;
    handles.invalidate();
    expect(() => handles.resolve(goneHandle)).toThrow(STALE_HANDLE_MESSAGE);
    expect(handles.resolve({ ...goneHandle, id: "test:e2" })).toBe(kept);
  });
});
