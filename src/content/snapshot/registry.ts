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
    const name = accessibleName(el);
    const visible = isElementVisible(el);
    const enabled = isElementEnabled(el);
    const clickable = isClickTarget(el, name);
    const base: InteractiveElement = {
      id: el.getAttribute(EID_ATTR) ?? this.register(el),
      role,
      name,
      tag: el.tagName.toLowerCase(),
      domId: el.id || undefined,
      visible,
      enabled,
      clickable,
      actionable: clickable && visible && enabled && hasPotentialClickPoint(el),
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
    || el.hasAttribute("onpointerup");
}

function isElementVisible(el: Element): boolean {
  if (el.getAttribute("aria-hidden") === "true") return false;
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function isElementEnabled(el: Element): boolean {
  try {
    if (el.matches(":disabled")) return false;
  } catch {
    // Stateful selectors are not supported by every SVG/custom element.
  }
  return !el.closest("[aria-disabled='true'], [inert]");
}

const CLICK_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
]);

function isClickTarget(el: Element, name: string): boolean {
  const rawClickable = isRawClickTarget(el);
  if (!rawClickable) return false;
  // Event-delegating containers often wrap the actual button/link and expose
  // the same accessible name. Prefer the concrete descendant in that case.
  if (!isNativeClickTarget(el) && hasEquivalentClickableDescendant(el, name)) return false;
  return true;
}

function isRawClickTarget(el: Element): boolean {
  if (isNativeClickTarget(el)) return true;
  const role = (el.getAttribute("role") ?? "").toLowerCase();
  return CLICK_ROLES.has(role) || hasJavaScriptClickBehavior(el);
}

function isNativeClickTarget(el: Element): boolean {
  if (el instanceof HTMLAnchorElement) return Boolean(el.href);
  if (el instanceof HTMLButtonElement) return true;
  if (el.tagName === "SUMMARY") return true;
  if (el instanceof HTMLInputElement) {
    return ["button", "submit", "reset", "image", "checkbox", "radio"].includes(el.type);
  }
  return false;
}

function hasEquivalentClickableDescendant(el: Element, name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return false;
  for (const child of el.querySelectorAll<Element>(
    "button, a[href], input[type='button'], input[type='submit'], input[type='reset'], input[type='image'], input[type='checkbox'], input[type='radio'], summary, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='switch'], [role='menuitem'], [role='tab']",
  )) {
    if (isRawClickTarget(child) && normalizeName(accessibleName(child)) === normalized) return true;
  }
  return false;
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Rejects controls that are already covered or have pointer events disabled.
 * Off-screen controls remain eligible because clickElement scrolls them first.
 */
function hasPotentialClickPoint(el: Element): boolean {
  if (window.getComputedStyle(el).pointerEvents === "none") return false;
  const rect = el.getBoundingClientRect();
  const intersectsViewport = rect.right > 0
    && rect.bottom > 0
    && rect.left < window.innerWidth
    && rect.top < window.innerHeight;
  if (!intersectsViewport) return true;

  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right - left < 1 || bottom - top < 1) return false;
  const insetX = Math.min(2, (right - left) / 4);
  const insetY = Math.min(2, (bottom - top) / 4);
  const points = [
    [(left + right) / 2, (top + bottom) / 2],
    [left + insetX, top + insetY],
    [right - insetX, top + insetY],
    [left + insetX, bottom - insetY],
    [right - insetX, bottom - insetY],
  ];
  return points.some(([x, y]) => {
    const hit = document.elementFromPoint(x, y);
    return Boolean(hit && isComposedDescendant(hit, el));
  });
}

function isComposedDescendant(candidate: Element, target: Element): boolean {
  let current: Element | null = candidate;
  while (current) {
    if (current === target) return true;
    if (current.parentElement) {
      current = current.parentElement;
      continue;
    }
    const root = current.getRootNode();
    current = typeof ShadowRoot !== "undefined" && root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}
