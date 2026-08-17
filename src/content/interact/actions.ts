/**
 * DOM interaction handlers executed inside the content script. Targets are
 * resolved through the stable-id registry and user-facing actions use a
 * Playwright-style actionability wait before touching the page.
 */

import type { ContentErrorDetail, InteractiveElement } from "@/shared/contentProtocol";
import { accessibleName } from "../snapshot/accessibleName";
import type { ElementRegistry } from "../snapshot/registry";
import {
  isFillableInputType,
  waitForActionable,
  type ActionabilityResult,
  type ActionPoint,
} from "./actionability";

export interface InteractionOutcome {
  data?: unknown;
  error?: ContentErrorDetail;
}

const elementNotFound = (localId: string): ContentErrorDetail => ({
  code: "ELEMENT_NOT_FOUND",
  message: `Element ${localId} no longer exists or its identity changed.`,
  suggestedAction: "Refresh the page snapshot and retry.",
});

const notInteractable = (localId: string, reason = "is not interactable"): ContentErrorDetail => ({
  code: "ELEMENT_NOT_INTERACTABLE",
  message: `Element ${localId} ${reason}.`,
  suggestedAction: "Wait for the control to become ready, dismiss any overlay, or choose another visible control.",
});

const invalidArguments = (message: string): ContentErrorDetail => ({
  code: "INVALID_TOOL_ARGUMENTS",
  message,
});

function resolve(registry: ElementRegistry, localId: string): Element | null {
  return registry.resolve(localId);
}

function actionabilityError(localId: string, result: ActionabilityResult): InteractionOutcome | null {
  if (result.ok) return null;
  return { error: result.missing ? elementNotFound(localId) : notInteractable(localId, `${result.reason} after waiting ${result.waitedMs}ms`) };
}

function describe(el: Element): Record<string, unknown> {
  const tag = el.tagName.toLowerCase();
  return {
    tag,
    name: accessibleName(el),
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
    type: el instanceof HTMLInputElement ? el.type : undefined,
  };
}

// ---------------------------------------------------------------------------
// Pointer actions
// ---------------------------------------------------------------------------

export async function clickElement(registry: ElementRegistry, localId: string): Promise<InteractionOutcome> {
  const actionable = await waitForActionable(registry, localId, {
    enabled: true,
    stable: true,
    receivesEvents: true,
    scrollIntoView: true,
  });
  const failure = actionabilityError(localId, actionable);
  if (failure || !actionable.ok) return failure ?? { error: elementNotFound(localId) };

  const target = describe(actionable.element);
  try {
    dispatchClickSequence(actionable.element, actionable.point!);
  } catch (err) {
    return { error: { code: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) } };
  }
  return {
    data: {
      action: "click",
      target,
      waitedMs: actionable.waitedMs,
      page: { url: location.href, title: document.title },
    },
  };
}

export function focusElement(registry: ElementRegistry, localId: string): InteractionOutcome {
  const el = resolve(registry, localId);
  if (!el) return { error: elementNotFound(localId) };
  focus(el, true);
  return { data: { action: "focus", target: describe(el) } };
}

export async function hoverElement(registry: ElementRegistry, localId: string): Promise<InteractionOutcome> {
  const actionable = await waitForActionable(registry, localId, {
    stable: true,
    receivesEvents: true,
    scrollIntoView: true,
  });
  const failure = actionabilityError(localId, actionable);
  if (failure || !actionable.ok) return failure ?? { error: elementNotFound(localId) };
  dispatchHoverSequence(actionable.element, actionable.point!);
  return { data: { action: "hover", target: describe(actionable.element), waitedMs: actionable.waitedMs } };
}

function dispatchClickSequence(element: Element, point: ActionPoint): void {
  dispatchHoverSequence(element, point);
  const pointerDownAllowed = dispatchPointer(element, "pointerdown", point, 1, true);
  const mouseDownAllowed = dispatchMouse(element, "mousedown", point, 1, true);
  if (pointerDownAllowed && mouseDownAllowed) focus(element, true);
  dispatchPointer(element, "pointerup", point, 0, true);
  dispatchMouse(element, "mouseup", point, 0, true);

  // HTMLElement.click() provides the browser's activation behavior for links,
  // buttons, details and form controls. The preceding events cover sites that
  // attach their behavior to pointerdown/mousedown instead of click.
  const activatable = element as Element & { click?: () => void };
  if (typeof activatable.click === "function") activatable.click();
  else dispatchMouse(element, "click", point, 0, true);
}

function dispatchHoverSequence(element: Element, point: ActionPoint): void {
  dispatchPointer(element, "pointerover", point, 0, true);
  dispatchMouse(element, "mouseover", point, 0, true);
  dispatchPointer(element, "pointerenter", point, 0, false);
  dispatchMouse(element, "mouseenter", point, 0, false);
  dispatchPointer(element, "pointermove", point, 0, true);
  dispatchMouse(element, "mousemove", point, 0, true);
}

function dispatchPointer(element: Element, type: string, point: ActionPoint, buttons: number, bubbles: boolean): boolean {
  const init: PointerEventInit = {
    bubbles,
    cancelable: true,
    composed: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    button: type.endsWith("down") || type.endsWith("up") ? 0 : -1,
    buttons,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
  };
  const event = typeof PointerEvent === "function"
    ? new PointerEvent(type, init)
    : new MouseEvent(type, init);
  return element.dispatchEvent(event);
}

function dispatchMouse(element: Element, type: string, point: ActionPoint, buttons: number, bubbles: boolean): boolean {
  return element.dispatchEvent(new MouseEvent(type, {
    bubbles,
    cancelable: true,
    composed: true,
    view: window,
    clientX: point.x,
    clientY: point.y,
    button: type === "mousedown" || type === "mouseup" ? 0 : -1,
    buttons,
    detail: type === "mousemove" ? 0 : 1,
  }));
}

function focus(element: Element, preventScroll: boolean): void {
  const focusable = element as Element & { focus?: (options?: FocusOptions) => void };
  if (typeof focusable.focus === "function") focusable.focus({ preventScroll });
}

// ---------------------------------------------------------------------------
// Filling
// ---------------------------------------------------------------------------

/** Per-element value history for undo support (kept in-memory per frame). */
const valueHistory = new Map<string, string[]>();

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

function dispatchBeforeInput(el: Element, inputType: string, data: string | null): boolean {
  return el.dispatchEvent(new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    composed: true,
    inputType,
    data,
  }));
}

function dispatchInputEvents(el: Element, inputType: string, data: string | null): void {
  el.dispatchEvent(new InputEvent("input", {
    bubbles: true,
    composed: true,
    inputType,
    data,
  }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function normalizedInputValue(el: HTMLInputElement, value: string): string {
  const type = el.type.toLowerCase();
  if (["number", "date", "time", "datetime-local", "month", "week", "range", "color"].includes(type)) value = value.trim();
  return type === "color" ? value.toLowerCase() : value;
}

function validateNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): string | null {
  if (el instanceof HTMLTextAreaElement) return null;
  const previous = el.value;
  setNativeValue(el, value);
  const accepted = el.value === value;
  setNativeValue(el, previous);
  return accepted ? null : `Value ${JSON.stringify(value)} is invalid for input type \"${el.type}\".`;
}

async function fillTextEntry(
  registry: ElementRegistry,
  localId: string,
  text: string,
  action: "type_text" | "clear_input" | "restore_input",
  recordHistory: boolean,
): Promise<InteractionOutcome> {
  const initial = resolve(registry, localId);
  if (!initial) return { error: elementNotFound(localId) };
  if (initial instanceof HTMLInputElement && !isFillableInputType(initial.type)) {
    return { error: invalidArguments(`Input type \"${initial.type}\" cannot be filled with text.`) };
  }
  if (!(initial instanceof HTMLInputElement || initial instanceof HTMLTextAreaElement || (initial instanceof HTMLElement && initial.isContentEditable))) {
    return { error: invalidArguments(`Element ${localId} is not a text input, textarea, or contenteditable element.`) };
  }

  const actionable = await waitForActionable(registry, localId, {
    enabled: true,
    editable: true,
    scrollIntoView: true,
  });
  const failure = actionabilityError(localId, actionable);
  if (failure || !actionable.ok) return failure ?? { error: elementNotFound(localId) };

  const el = actionable.element;
  const target = describe(el);
  const previous = currentTextValue(el);
  const inputType = text ? "insertText" : "deleteContentBackward";
  const inputData = text || null;
  let requested = text;
  if (el instanceof HTMLInputElement) requested = normalizedInputValue(el, text);
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const validationError = validateNativeValue(el, requested);
    if (validationError) return { error: invalidArguments(validationError) };
  }

  focus(el, false);
  if (!dispatchBeforeInput(el, inputType, inputData)) {
    return { error: notInteractable(localId, "was prevented from accepting input by the page") };
  }
  if (recordHistory) pushHistory(localId, previous);

  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    setNativeValue(el, requested);
    try {
      el.setSelectionRange(requested.length, requested.length);
    } catch {
      // Date/color/range and several other native input types have no text selection.
    }
  } else if (el instanceof HTMLElement && el.isContentEditable) {
    el.replaceChildren(document.createTextNode(requested));
    placeCaretAtEnd(el);
  }
  dispatchInputEvents(el, inputType, inputData);
  await Promise.resolve();

  const actual = currentTextValue(el);
  if (el.isConnected && requested !== previous && actual === previous) {
    return { error: notInteractable(localId, "restored its previous value after the input event") };
  }
  return {
    data: {
      action,
      target,
      chars: requested.length,
      value: maskSensitive(el, actual),
      valueAccepted: actual === requested,
      waitedMs: actionable.waitedMs,
    },
  };
}

export function typeText(registry: ElementRegistry, localId: string, text: string): Promise<InteractionOutcome> {
  return fillTextEntry(registry, localId, text, "type_text", true);
}

export function clearInput(registry: ElementRegistry, localId: string): Promise<InteractionOutcome> {
  return fillTextEntry(registry, localId, "", "clear_input", true);
}

function currentTextValue(el: Element): string {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return el.value;
  return el.textContent ?? "";
}

function placeCaretAtEnd(el: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  selection.removeAllRanges();
  selection.addRange(range);
}

function maskSensitive(el: Element, value: string): string {
  if (el instanceof HTMLInputElement && el.type === "password") return "•".repeat(Math.min(value.length, 12));
  return value;
}

function pushHistory(localId: string, value: string): void {
  const list = valueHistory.get(localId) ?? [];
  list.push(value);
  if (list.length > 20) list.shift();
  valueHistory.set(localId, list);
}

export async function restoreInput(registry: ElementRegistry, localId: string): Promise<InteractionOutcome> {
  const el = resolve(registry, localId);
  if (!el) return { error: elementNotFound(localId) };
  const list = valueHistory.get(localId);
  const previous = list?.pop();
  if (previous === undefined) {
    return { data: { action: "restore_input", restored: false, reason: "no previous value recorded" } };
  }
  if (el instanceof HTMLSelectElement) {
    setNativeValue(el, previous);
    dispatchSelectEvents(el);
    return { data: { action: "restore_input", restored: true } };
  }
  const result = await fillTextEntry(registry, localId, previous, "restore_input", false);
  if (result.error) list?.push(previous);
  return result.error ? result : { data: { ...(result.data as Record<string, unknown>), restored: true } };
}

export function getInputHistory(registry: ElementRegistry, localId: string): InteractionOutcome {
  const el = resolve(registry, localId);
  if (!el) return { error: elementNotFound(localId) };
  return { data: { action: "input_history", values: valueHistory.get(localId) ?? [] } };
}

// ---------------------------------------------------------------------------
// Selects & checkboxes
// ---------------------------------------------------------------------------

export async function selectOption(registry: ElementRegistry, localId: string, value: string): Promise<InteractionOutcome> {
  const initial = resolve(registry, localId);
  if (!initial) return { error: elementNotFound(localId) };
  if (!(initial instanceof HTMLSelectElement)) return { error: invalidArguments(`Element ${localId} is not a <select>.`) };

  const actionable = await waitForActionable(registry, localId, { enabled: true });
  const failure = actionabilityError(localId, actionable);
  if (failure || !actionable.ok) return failure ?? { error: elementNotFound(localId) };
  const el = actionable.element;
  if (!(el instanceof HTMLSelectElement)) return { error: elementNotFound(localId) };

  const option = [...el.options].find((candidate) => candidate.value === value || candidate.text === value);
  if (!option) {
    return {
      error: invalidArguments(`Option \"${value}\" not found. Available: ${[...el.options].slice(0, 20).map((candidate) => `\"${candidate.text}\"`).join(", ")}`),
    };
  }
  if (option.disabled || option.closest("optgroup[disabled]")) {
    return { error: notInteractable(localId, `has disabled option \"${option.text}\"`) };
  }
  pushHistory(localId, el.value);
  setNativeValue(el, option.value);
  dispatchSelectEvents(el);
  if (el.value !== option.value) return { error: notInteractable(localId, `did not retain option \"${option.text}\"`) };
  return { data: { action: "select_option", target: describe(el), selected: option.text, waitedMs: actionable.waitedMs } };
}

function dispatchSelectEvents(el: HTMLSelectElement): void {
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export async function setChecked(registry: ElementRegistry, localId: string, checked: boolean): Promise<InteractionOutcome> {
  const initial = resolve(registry, localId);
  if (!initial) return { error: elementNotFound(localId) };
  const initialState = checkedState(initial);
  if (initialState === undefined) return { error: invalidArguments(`Element ${localId} is not a checkbox, radio, or switch.`) };
  if (initial instanceof HTMLInputElement && initial.type === "radio" && !checked) {
    return { error: invalidArguments("Radio buttons cannot be unchecked directly; check another radio button in the group.") };
  }
  if (initialState === checked) return { data: { action: "set_checked", target: describe(initial), checked } };

  const actionable = await waitForActionable(registry, localId, {
    enabled: true,
    stable: true,
    receivesEvents: true,
    scrollIntoView: true,
  });
  const failure = actionabilityError(localId, actionable);
  if (failure || !actionable.ok) return failure ?? { error: elementNotFound(localId) };
  dispatchClickSequence(actionable.element, actionable.point!);

  const changed = await waitForCheckedState(actionable.element, checked);
  if (!changed) return { error: notInteractable(localId, `did not change to checked=${checked} after being clicked`) };
  return {
    data: {
      action: "set_checked",
      target: describe(actionable.element),
      checked,
      waitedMs: actionable.waitedMs,
    },
  };
}

function checkedState(el: Element): boolean | undefined {
  if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) return el.checked;
  if (["checkbox", "radio", "switch"].includes(el.getAttribute("role") ?? "")) return el.getAttribute("aria-checked") === "true";
  return undefined;
}

async function waitForCheckedState(el: Element, expected: boolean): Promise<boolean> {
  const deadline = Date.now() + 500;
  while (Date.now() <= deadline) {
    if (checkedState(el) === expected) return true;
    if (!el.isConnected) return true;
    await new Promise<void>((resolvePromise) => window.setTimeout(resolvePromise, 25));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scrolling
// ---------------------------------------------------------------------------

export function scrollBy(dx: number, dy: number): InteractionOutcome {
  window.scrollBy({ left: dx, top: dy, behavior: "auto" });
  return { data: { action: "scroll", dx, dy, scrollX: window.scrollX, scrollY: window.scrollY } };
}

export function scrollToElement(registry: ElementRegistry, localId: string): InteractionOutcome {
  const el = resolve(registry, localId);
  if (!el) return { error: elementNotFound(localId) };
  el.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
  return { data: { action: "scroll_to_element", target: describe(el) } };
}

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

const KEY_CODES: Record<string, { keyCode: number; code: string }> = {
  Enter: { keyCode: 13, code: "Enter" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
  Space: { keyCode: 32, code: "Space" },
};

export function pressKey(registry: ElementRegistry, localId: string | undefined, key: string): InteractionOutcome {
  const el = localId ? resolve(registry, localId) : document.activeElement;
  if (!el) return { error: localId ? elementNotFound(localId) : { code: "ELEMENT_NOT_FOUND", message: "No focused element." } };
  focus(el, false);
  const mapping = KEY_CODES[key] ?? { keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0, code: key };
  const init: KeyboardEventInit = {
    key,
    code: mapping.code,
    keyCode: mapping.keyCode,
    which: mapping.keyCode,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  for (const type of ["keydown", "keypress", "keyup"] as const) el.dispatchEvent(new KeyboardEvent(type, init));
  return { data: { action: "press_key", key, target: describe(el) } };
}

/** Compact element summary used by observation formatting. */
export function compactElements(elements: InteractiveElement[], max = 30): { id: string; role: string; name: string }[] {
  return elements.slice(0, max).map((element) => ({ id: element.id, role: element.role, name: element.name.slice(0, 100) }));
}
