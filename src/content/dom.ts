export function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function collectRoots(): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [document];
  for (let index = 0; index < roots.length; index += 1) {
    for (const element of roots[index]!.querySelectorAll("*")) {
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return roots;
}

export function composedParent(element: Element): Element | null {
  return (
    element.parentElement ??
    (element.getRootNode() instanceof ShadowRoot ? (element.getRootNode() as ShadowRoot).host : null)
  );
}

export function isVisible(element: Element): boolean {
  for (let current: Element | null = element; current; current = composedParent(current)) {
    const style = getComputedStyle(current);
    if (
      current.hasAttribute("hidden") ||
      current.getAttribute("aria-hidden") === "true" ||
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.visibility === "collapse" ||
      Number(style.opacity) === 0
    )
      return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function isDisabled(element: Element): boolean {
  if (element.matches(":disabled")) return true;
  for (let current: Element | null = element; current; current = composedParent(current)) {
    if (current.hasAttribute("inert") || current.getAttribute("aria-disabled") === "true") return true;
  }
  return false;
}

export function semanticRole(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit.split(/\s+/u)[0]!;
  if (element instanceof HTMLAnchorElement) return "link";
  if (element instanceof HTMLButtonElement) return "button";
  if (element instanceof HTMLSelectElement) return "combobox";
  if (element instanceof HTMLTextAreaElement || (element instanceof HTMLElement && element.isContentEditable))
    return "textbox";
  if (element instanceof HTMLInputElement) {
    if (["checkbox", "radio"].includes(element.type)) return element.type;
    if (["button", "submit", "reset"].includes(element.type)) return "button";
    return "textbox";
  }
  return element.tagName.toLowerCase();
}

export function accessibleName(element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const root = element.getRootNode() as Document | ShadowRoot;
    const text = normalizeText(
      labelledBy
        .split(/\s+/u)
        .map((id) => (root.getElementById(id) ? safeText(root.getElementById(id)!) : ""))
        .join(" "),
    );
    if (text) return text;
  }
  const aria = normalizeText(element.getAttribute("aria-label") ?? "");
  if (aria) return aria;
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const labels = normalizeText([...(element.labels ?? [])].map((label) => safeText(label)).join(" "));
    if (labels) return labels;
    if (!(element instanceof HTMLSelectElement) && element.placeholder)
      return normalizeText(element.placeholder);
    // Never derive a name from a text field's current value or a select's options.
    if (element instanceof HTMLInputElement && ["submit", "reset", "button"].includes(element.type))
      return element.value || element.type;
    return element.getAttribute("title") || element.name || element.id;
  }
  if (element instanceof HTMLElement && element.isContentEditable)
    return element.getAttribute("title") || "Editable text";
  return (
    safeText(element) ||
    element.getAttribute("title") ||
    element.querySelector("img[alt]")?.getAttribute("alt") ||
    ""
  );
}

export function identityOf(element: Element) {
  const form =
    element instanceof HTMLInputElement || element instanceof HTMLButtonElement
      ? element.form
      : element.closest("form");
  return {
    tag: element.tagName,
    name: accessibleName(element),
    semantics: JSON.stringify([
      semanticRole(element),
      element instanceof HTMLAnchorElement ? element.href : null,
      ...["href", "type", "name", "formaction", "formmethod"].map((key) => element.getAttribute(key)),
      form?.action,
      form?.method,
    ]),
  };
}

export function isSensitive(input: HTMLInputElement): boolean {
  const descriptor =
    `${input.type} ${input.name} ${input.id} ${input.autocomplete} ${input.placeholder}`.toLowerCase();
  return (
    input.type === "password" || /(otp|one.?time|verification|card|cvv|cvc|security.?code)/u.test(descriptor)
  );
}

/** Do not read live form/editable contents through an ancestor's textContent. */
export function safeText(element: Element, localBlock = false): string {
  if (
    element.matches(
      "input,textarea,select,[contenteditable]:not([contenteditable='false']),script,style,[aria-hidden='true'],[hidden]",
    )
  )
    return "";
  let text = "";
  for (const child of element.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += child.textContent ?? "";
    else if (child instanceof Element && isVisible(child)) {
      if (localBlock && child.matches("main,article,section,h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,tr,div"))
        continue;
      text += ` ${safeText(child, localBlock)} `;
    }
  }
  return normalizeText(text);
}
