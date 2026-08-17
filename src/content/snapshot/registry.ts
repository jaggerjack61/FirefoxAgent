/**
 * ElementRegistry: maps frame-local element ids ("E1", "E2", ...) to DOM
 * elements and validates them against their recorded identity before any
 * interaction. Stale elements (DOM mutated) are rejected so the agent can
 * never silently act on the wrong node.
 */

import { elementIdentityHash, identityOfElement } from "@/shared/semanticMatch";
import type { InteractiveElement } from "@/shared/contentProtocol";
import { accessibleName } from "./accessibleName";

const EID_ATTR = "data-ffa-eid";

export interface RegisteredElement {
  element: Element;
  hash: string;
}

export class ElementRegistry {
  private readonly byId = new Map<string, RegisteredElement>();
  private nextId = 1;

  /** Assigns the next id to `el` and registers its identity. */
  register(el: Element): string {
    const existing = el.getAttribute(EID_ATTR);
    if (existing) {
      const entry = this.byId.get(existing);
      if (entry?.element === el) {
        // A fresh snapshot establishes a fresh identity baseline. Without
        // this update, a label/role change made between snapshots causes the
        // next interaction to fail once even though its id is current.
        entry.hash = this.hashOf(el);
        return existing;
      }
      if (!entry && /^E\d+$/.test(existing)) {
        this.byId.set(existing, { element: el, hash: this.hashOf(el) });
        this.nextId = Math.max(this.nextId, Number(existing.slice(1)) + 1);
        return existing;
      }
    }
    let id = `E${this.nextId++}`;
    while (this.byId.has(id)) id = `E${this.nextId++}`;
    el.setAttribute(EID_ATTR, id);
    this.byId.set(id, { element: el, hash: this.hashOf(el) });
    return id;
  }

  clear(): void {
    this.byId.clear();
    this.nextId = 1;
  }

  /** Number of currently registered elements (for snapshot stats). */
  get size(): number {
    return this.byId.size;
  }

  /** Resolves and validates. Returns null when missing or identity changed. */
  resolve(localId: string): Element | null {
    const entry = this.byId.get(localId);
    if (!entry) return null;
    if (!entry.element.isConnected) {
      this.byId.delete(localId);
      return null;
    }
    if (this.hashOf(entry.element) !== entry.hash) {
      // Element identity changed — treat as stale, force a snapshot refresh.
      this.byId.delete(localId);
      return null;
    }
    return entry.element;
  }

  private hashOf(el: Element): string {
    return elementIdentityHash(identityOfElement(this.toInteractive(el, 0, false)));
  }

  toInteractive(el: Element, frameId: number, includeValue: boolean): InteractiveElement {
    const role = inferRole(el);
    const base: InteractiveElement = {
      id: el.getAttribute(EID_ATTR) ?? this.register(el),
      role,
      name: accessibleName(el),
      tag: el.tagName.toLowerCase(),
      visible: isElementVisible(el),
      inFrame: frameId !== 0,
      frameId,
    };
    if (el instanceof HTMLAnchorElement && el.href) base.href = el.href;
    if (el instanceof HTMLInputElement) {
      base.type = el.type || "text";
      base.checked = el.checked;
      base.required = el.required;
      if (includeValue && el.type !== "password") base.value = el.value;
    } else if (el instanceof HTMLTextAreaElement) {
      base.type = "textarea";
      base.required = el.required;
      if (includeValue) base.value = el.value;
    } else if (el instanceof HTMLSelectElement) {
      base.type = "select";
      base.required = el.required;
      if (includeValue) base.value = el.value;
    } else if (el instanceof HTMLButtonElement) {
      base.type = el.type || "button";
    }
    return base;
  }
}

export function inferRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el instanceof HTMLButtonElement) return "button";
  if (el instanceof HTMLAnchorElement) return el.href ? "link" : "button";
  if (el instanceof HTMLInputElement) {
    switch (el.type) {
      case "checkbox":
        return "checkbox";
      case "radio":
        return "radio";
      case "range":
        return "slider";
      case "submit":
      case "button":
      case "reset":
        return "button";
      default:
        return "input";
    }
  }
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  if (el.tagName === "SUMMARY") return "button";
  if ((el as HTMLElement).isContentEditable) return "textbox";
  if (hasJavaScriptClickBehavior(el)) return "button";
  return "element";
}

/**
 * Detects DOM-visible click behavior. Handlers installed with addEventListener
 * are not enumerable by browser APIs, so well-authored custom controls should
 * also expose a role or non-negative tabindex (both are covered here).
 */
export function hasJavaScriptClickBehavior(el: Element): boolean {
  const html = el as HTMLElement;
  return typeof html.onclick === "function"
    || typeof html.onmousedown === "function"
    || typeof html.onmouseup === "function"
    || typeof html.onpointerdown === "function"
    || typeof html.onpointerup === "function"
    || el.hasAttribute("onclick")
    || el.hasAttribute("onmousedown")
    || el.hasAttribute("onmouseup")
    || el.hasAttribute("onpointerdown")
    || el.hasAttribute("onpointerup")
    || (el.hasAttribute("tabindex") && html.tabIndex >= 0);
}

function isElementVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
