import { composedParent, isDisabled, isVisible, normalizeText } from "./dom";
import { abortableDelay } from "@/shared/abort";

const settle = (signal?: AbortSignal) => abortableDelay(150, signal);

function containsComposed(element: Element, target: Element): boolean {
  for (let current: Element | null = target; current; current = composedParent(current))
    if (current === element) return true;
  return false;
}

function assertActionable(element: Element): asserts element is HTMLElement {
  if (!(element instanceof HTMLElement) || !element.isConnected || !isVisible(element))
    throw new Error("Target is not visible or connected. Read the page again.");
  if (isDisabled(element)) throw new Error("Target is disabled or inert");
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left),
    right = Math.min(innerWidth, rect.right);
  const top = Math.max(0, rect.top),
    bottom = Math.min(innerHeight, rect.bottom);
  if (left >= right || top >= bottom) throw new Error("Target is outside the viewport");
  const x = (left + right) / 2,
    y = (top + bottom) / 2;
  let hit = document.elementFromPoint(x, y);
  while (hit?.shadowRoot) {
    const nested = hit.shadowRoot.elementFromPoint(x, y);
    if (!nested || nested === hit) break;
    hit = nested;
  }
  if (!hit || !containsComposed(element, hit))
    throw new Error("Target is covered by another element. Inspect the page before retrying.");
}

function checked(element: Element): boolean | null {
  if (element instanceof HTMLInputElement) return element.checked;
  const value = element.getAttribute("aria-checked");
  return value === "true" ? true : value === "false" ? false : null;
}

export async function performAction(
  action: "click" | "fill" | "select" | "set_checked" | "submit",
  resolve: () => Element,
  value: string | boolean | undefined,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  let element = resolve();
  if (!isVisible(element) || isDisabled(element)) throw new Error("Target is hidden, disabled, or inert");
  element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  await settle(signal);
  element = resolve(); // Scroll handlers can recycle virtualized nodes.
  assertActionable(element);
  element.focus({ preventScroll: true });
  element = resolve(); // Focus handlers may change the target as well.
  assertActionable(element);

  if (action === "fill") {
    if (typeof value !== "string") throw new Error("Fill requires text");
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.readOnly || element.getAttribute("aria-readonly") === "true")
        throw new Error("Target is read-only");
      if (
        element instanceof HTMLInputElement &&
        ![
          "text",
          "search",
          "email",
          "tel",
          "url",
          "password",
          "number",
          "date",
          "datetime-local",
          "month",
          "week",
          "time",
        ].includes(element.type)
      )
        throw new Error("Target is not a text input");
      const before = element.value;
      const prototype =
        element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(element, value);
      element.dispatchEvent(
        new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText" }),
      );
      element.dispatchEvent(new Event("change", { bubbles: true }));
      await settle(signal);
      const verified = element.isConnected && element.value === value;
      return { status: verified ? "succeeded" : "unverified", changed: verified && before !== value };
    }
    // Rich editors may have their own model; do not overwrite arbitrary child markup.
    throw new Error("Target is not a supported native text control");
  }

  if (action === "select") {
    if (!(element instanceof HTMLSelectElement) || typeof value !== "string")
      throw new Error("Target is not a select");
    if (element.multiple) throw new Error("Multi-select controls are not supported");
    const exact = [...element.options].filter((option) => option.value === value);
    const matches = exact.length
      ? exact
      : [...element.options].filter((option) => normalizeText(option.text) === normalizeText(value));
    if (matches.length !== 1)
      throw new Error("Select option is missing or ambiguous. Use a unique option value.");
    const option = matches[0]!;
    if (
      option.disabled ||
      (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled)
    )
      throw new Error("Select option is disabled");
    const before = element.value;
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, option.value);
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    await settle(signal);
    const verified = element.isConnected && element.value === option.value;
    return { status: verified ? "succeeded" : "unverified", changed: verified && before !== option.value };
  }

  if (action === "set_checked") {
    const native = element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type);
    if (
      typeof value !== "boolean" ||
      (!native && !["checkbox", "radio", "switch"].includes(element.getAttribute("role") ?? ""))
    )
      throw new Error("Target is not checkable");
    const before = checked(element);
    if (before === value) return { status: "succeeded", changed: false };
    if (
      value === false &&
      (element.getAttribute("role") === "radio" ||
        (element instanceof HTMLInputElement && element.type === "radio"))
    )
      throw new Error("Choose another radio option instead of unchecking this one");
    element.click(); // Native activation runs framework click handlers and respects preventDefault.
    await settle(signal);
    const verified = element.isConnected && checked(element) === value;
    return { status: verified ? "succeeded" : "unverified", changed: verified && before !== value };
  }

  const beforeUrl = location.href;
  const beforeExpanded = element.getAttribute("aria-expanded");
  const beforeChecked = checked(element);
  if (action === "submit") {
    const form =
      element instanceof HTMLInputElement || element instanceof HTMLButtonElement
        ? element.form
        : element.closest("form");
    if (!form) throw new Error("No containing form was found");
    if (!form.checkValidity()) return { status: "failed", changed: false, reason: "Form validation failed" };
    const submitter =
      (element instanceof HTMLButtonElement && element.type === "submit") ||
      (element instanceof HTMLInputElement && ["submit", "image"].includes(element.type))
        ? element
        : undefined;
    form.requestSubmit(submitter);
  } else element.click();
  await settle(signal);
  const changed =
    beforeUrl !== location.href ||
    beforeExpanded !== element.getAttribute("aria-expanded") ||
    beforeChecked !== checked(element);
  return {
    status: changed ? "succeeded" : "unverified",
    changed,
    ...(changed
      ? {}
      : { reason: "Action dispatched; read the page to verify the outcome. Do not blindly repeat." }),
  };
}
