/**
 * Accessible-name computation (WCAG-style) used for element detection.
 * Preference order: aria-label > aria-labelledby > associated label >
 * placeholder/value > visible text content. Brittle CSS classes are never
 * used — semantics only.
 */

const MAX_NAME_LENGTH = 160;

function textOf(el: Element | null | undefined): string {
  if (!el) return "";
  const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  return text.slice(0, MAX_NAME_LENGTH);
}

function ariaLabelledBy(el: Element): string {
  const refs = el.getAttribute("aria-labelledby");
  if (!refs) return "";
  const parts = refs
    .split(/\s+/)
    .map((id) => document.getElementById(id))
    .map(textOf)
    .filter(Boolean);
  return parts.join(" ").slice(0, MAX_NAME_LENGTH);
}

function labelForInput(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  // aria-label wins
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, MAX_NAME_LENGTH);
  const labelledBy = ariaLabelledBy(el);
  if (labelledBy) return labelledBy;

  // <label for="...">
  if (el.id) {
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
    const text = textOf(label);
    if (text) return text;
  }
  // wrapping <label>
  const wrapped = el.closest("label");
  const wrappedText = textOf(wrapped);
  if (wrappedText) return wrappedText;

  // fieldset/legend context for radio/checkbox groups
  const fieldset = el.closest("fieldset");
  if (fieldset) {
    const legend = textOf(fieldset.querySelector("legend"));
    const name = el.getAttribute("name")?.trim() ?? "";
    const combined = [legend, name ? `(${name})` : ""].filter(Boolean).join(" ").trim();
    if (combined) return combined.slice(0, MAX_NAME_LENGTH);
  }
  return "";
}

function stableInputFallback(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): string {
  if (el instanceof HTMLSelectElement) return "";
  const ph = el.getAttribute("placeholder")?.trim();
  if (ph) return ph.slice(0, MAX_NAME_LENGTH);
  const title = el.getAttribute("title")?.trim();
  if (title) return title.slice(0, MAX_NAME_LENGTH);
  // Button-like inputs derive their accessible name from value. Text-entry
  // values are deliberately excluded: typing must not change element identity.
  if (el instanceof HTMLInputElement && ["button", "submit", "reset"].includes(el.type)) {
    const value = el.value.trim();
    if (value) return value.slice(0, MAX_NAME_LENGTH);
  }
  const name = el.getAttribute("name")?.trim();
  if (name) return name.slice(0, MAX_NAME_LENGTH);
  return "";
}

export function accessibleName(el: Element): string {
  // Explicit overrides first.
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel?.trim()) return ariaLabel.trim().slice(0, MAX_NAME_LENGTH);
  const labelledBy = ariaLabelledBy(el);
  if (labelledBy) return labelledBy;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const label = labelForInput(el);
    if (label) return label;
    return stableInputFallback(el);
  }
  if (el instanceof HTMLImageElement) return el.alt?.trim().slice(0, MAX_NAME_LENGTH) ?? "";
  const title = el.getAttribute("title");
  if (title?.trim()) return title.trim().slice(0, MAX_NAME_LENGTH);
  return textOf(el);
}
