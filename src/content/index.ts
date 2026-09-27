import {
  contentCommandSchema,
  formatHandle,
  pageSnapshotSchema,
  type ContentCommand,
  type ElementHandle,
  type PageElement,
} from "@/shared/schema";
import { abortableDelay } from "@/shared/abort";
import { lexicalScore } from "@/shared/token";
import { HandleRegistry } from "./handleRegistry";
import {
  accessibleName,
  collectRoots,
  identityOf,
  isDisabled,
  isSensitive,
  isVisible,
  normalizeText,
  safeText,
  semanticRole,
} from "./dom";
import { paginateSnapshot, splitPassage, type SnapshotItem } from "./snapshot";
import { performAction } from "./interactions";

declare global {
  interface Window {
    __browserAgentContentV1?: boolean;
  }
}

if (!window.__browserAgentContentV1) {
  window.__browserAgentContentV1 = true;
  installContentRuntime();
}

function installContentRuntime(): void {
  const handles = new HandleRegistry<Element>(identityOf);
  const observer = new MutationObserver(() => handles.invalidate());
  const observed = new WeakSet<Document | ShadowRoot>();
  const roots = () => {
    const result = collectRoots();
    for (const root of result) {
      if (observed.has(root)) continue;
      observed.add(root);
      observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    return result;
  };
  roots();
  const flush = () => {
    if (observer.takeRecords().length) handles.invalidate();
  };

  // In-flight act/wait work, so the background can cancel it on Stop even
  // though Firefox message delivery itself is not abortable.
  const operations = new Map<string, AbortController>();

  browser.runtime.onMessage.addListener((raw: unknown) => {
    const parsed = contentCommandSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const command = parsed.data;
    // Keep errors as rejected responses, including synchronous validation failures.
    return Promise.resolve().then(() => {
      flush();
      if (command.type === "cancel_operation") {
        const controller = operations.get(command.operationId);
        controller?.abort(new DOMException("Stopped", "AbortError"));
        operations.delete(command.operationId);
        return { cancelled: Boolean(controller) };
      }
      const operationId = "operationId" in command ? command.operationId : undefined;
      let controller: AbortController | undefined;
      if (operationId) {
        controller = new AbortController();
        operations.set(operationId, controller);
      }
      const task = Promise.resolve().then(() => dispatch(command, controller?.signal));
      if (controller && operationId) {
        void task.finally(() => {
          if (operations.get(operationId) === controller) operations.delete(operationId);
        });
      }
      return task;
    });
  });

  function dispatch(
    command: Exclude<ContentCommand, { type: "cancel_operation" }>,
    signal: AbortSignal | undefined,
  ): Promise<unknown> | Record<string, unknown> {
    if (command.type === "snapshot")
      return buildSnapshot(
        command.tabId,
        command.frameId,
        command.query,
        command.cursor,
        command.maxTokens,
        command.mode,
      );
    if (command.type === "describe") return describe(command.handle);
    if (command.type === "act")
      return performAction(
        command.action,
        () => {
          flush();
          return handles.resolve(command.handle);
        },
        command.value,
        signal,
      );
    return waitFor(command.condition, command.timeoutMs, signal);
  }

  function describe(handle: ElementHandle): Record<string, unknown> {
    const element = handles.resolve(handle);
    const role = semanticRole(element);
    const href = element instanceof HTMLAnchorElement ? element.href : undefined;
    return {
      name: accessibleName(element).slice(0, 200),
      role,
      tag: element.tagName.toLowerCase(),
      href,
      kind: href ? "navigation" : ["button", "menuitem", "tab"].includes(role) ? "control" : "unknown",
    };
  }

  function buildSnapshot(
    tabId: number,
    frameId: number,
    query: string,
    cursor: string | null,
    maxTokens: number,
    mode: "all" | "text" | "controls",
  ) {
    const items: SnapshotItem[] = [];
    const seen = new Set<string>();
    for (const root of roots()) {
      if (mode !== "controls")
        for (const element of root.querySelectorAll(
          "body,main,article,section,h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,tr,div",
        )) {
          if (
            !isVisible(element) ||
            element.closest("input,textarea,select,[contenteditable]:not([contenteditable='false'])")
          )
            continue;
          // Keep a container's own prose while its nested blocks are extracted separately.
          const text = safeText(element, true);
          if (text.length < 2 || seen.has(text)) continue;
          seen.add(text);
          const kind = /^H[1-6]$/u.test(element.tagName)
            ? "heading"
            : element.tagName === "LI"
              ? "list"
              : element.tagName === "TR"
                ? "table"
                : undefined;
          const boilerplate = element.closest("nav,header,footer,aside") ? 0.1 : 0;
          for (const passage of splitPassage(text)) {
            const score = lexicalScore(query, passage) + (kind === "heading" ? 0.05 : 0) - boilerplate;
            items.push({ block: kind ? { kind, text: passage } : { text: passage }, score });
          }
        }
      if (mode !== "text")
        for (const element of root.querySelectorAll(
          "a[href],button,input,textarea,select,summary,[role='button'],[role='link'],[role='checkbox'],[role='radio'],[role='switch'],[role='tab'],[role='menuitem'],[role='combobox'],[role='textbox']",
        )) {
          if (!isVisible(element)) continue;
          const role = semanticRole(element);
          const fullName = accessibleName(element);
          const name = fullName.slice(0, 180);
          const state: NonNullable<PageElement["state"]> = {};
          let options: PageElement["options"];
          if (fullName.length > 180) state.nameTruncated = true;
          if (isDisabled(element)) state.disabled = true;
          for (const attribute of ["expanded", "checked", "selected", "required", "readonly", "invalid"]) {
            const value = element.getAttribute(`aria-${attribute}`);
            if (value !== null) state[attribute] = value;
          }
          if (element instanceof HTMLInputElement) {
            state.type = element.type;
            if (["checkbox", "radio"].includes(element.type)) state.checked = element.checked;
            if (isSensitive(element)) state.sensitive = true;
          }
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            if (element.readOnly) state.readonly = true;
          }
          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          ) {
            if (element.required) state.required = true;
          }
          if (element instanceof HTMLSelectElement) {
            // Expose choices, never the existing selected value. Query ranks large option lists.
            const choices = [...element.options].sort(
              (a, b) => lexicalScore(query, b.text) - lexicalScore(query, a.text),
            );
            options = choices.slice(0, 6).map((option) => {
              const label = normalizeText(option.text);
              const disabled =
                option.disabled ||
                (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled);
              return {
                label: label.slice(0, 120),
                // select matches a value or a visible label; repeat the value only when it differs,
                // and never invent a clipped value that cannot be selected.
                ...(option.value !== label && option.value.length <= 80 ? { value: option.value } : {}),
                ...(label.length > 120 ? { labelTruncated: true as const } : {}),
                ...(disabled ? { disabled: true as const } : {}),
              };
            });
            if (choices.length > 6)
              state.optionsHint = `${choices.length} choices; query an option label to find more`;
          }
          if (element instanceof HTMLAnchorElement) {
            state.href = element.href.slice(0, 240);
            if (element.href.length > 240) state.hrefTruncated = true;
          }
          const optionText = options?.map((option) => option.label).join(" ") ?? "";
          const score = lexicalScore(query, `${role} ${fullName} ${optionText}`) + 0.02;
          items.push({
            element: {
              handle: formatHandle(handles.bind(element, tabId, frameId)),
              role,
              name,
              ...(Object.keys(state).length ? { state } : {}),
              ...(options ? { options } : {}),
            },
            score,
          });
        }
    }
    items.sort((a, b) => b.score - a.score); // Stable tie order preserves document order.
    const warnings = document.querySelector("iframe")
      ? ["Subframes are not included; use a separate frameId read."]
      : [];
    const snapshot = paginateSnapshot(
      {
        tabId,
        frameId,
        url: location.href,
        title: document.title.slice(0, 180),
        query,
        warnings,
      },
      items,
      cursor,
      maxTokens,
      mode,
    );
    return pageSnapshotSchema.parse(snapshot);
  }

  async function waitFor(
    condition: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const wanted = normalizeText(condition).toLowerCase();
    if (!wanted) throw new Error("Wait condition must be non-empty visible text");
    const deadline = Date.now() + timeoutMs;
    // Poll at a bounded rate: this also catches visibility/property changes and shadow DOM.
    do {
      if (
        roots().some((root) => {
          const containers = root instanceof Document ? (root.body ? [root.body] : []) : [...root.children];
          return containers.some(
            (element) => isVisible(element) && safeText(element).toLowerCase().includes(wanted),
          );
        })
      )
        return { matched: true };
      await abortableDelay(Math.min(200, Math.max(0, deadline - Date.now())), signal);
    } while (Date.now() < deadline);
    return { matched: false, reason: "timeout" };
  }
}
