/**
 * Content script entry point. Handles typed messages from the background
 * script (snapshot building, interaction, extraction) and reports page
 * changes. It NEVER talks to the LLM or the network beyond the page itself.
 */

import type { ContentRequest, ContentResponse, FrameSnapshot, PageSnapshot } from "@/shared/contentProtocol";
import { ToolError, type ErrorCode } from "@/shared/errors";
import { ElementRegistry } from "./snapshot/registry";
import { buildSnapshot, visibleViewportText } from "./snapshot/builder";
import * as actions from "./interact/actions";
import { extractTable, extractList, extractLinks, extractStructuredContent } from "./extract/extractors";
import { DomObserver } from "./observers";

const registry = new ElementRegistry();

interface SnapshotOptions {
  maxTextChars: number;
  maxElements: number;
  maxLinks: number;
  includeValues: boolean;
}

const DEFAULTS: SnapshotOptions = {
  maxTextChars: 12_000,
  maxElements: 120,
  maxLinks: 200,
  includeValues: false,
};

let currentSnapshot: PageSnapshot | null = null;

function refreshSnapshot(opts: Partial<SnapshotOptions> = {}): PageSnapshot {
  const merged = { ...DEFAULTS, ...opts };
  currentSnapshot = buildSnapshot({
    registry,
    frameId: 0,
    includeValues: merged.includeValues,
    maxTextChars: merged.maxTextChars,
    maxElements: merged.maxElements,
    maxLinks: merged.maxLinks,
  });
  return currentSnapshot;
}

/** Builds a snapshot for a given frame (top frame aggregates nothing here). */
function snapshotForFrame(frameId: number, opts: Partial<SnapshotOptions> = {}): FrameSnapshot {
  return { frameId, snapshot: refreshSnapshot(opts) };
}

interface DispatchResult {
  data?: unknown;
  error?: { code: ErrorCode; message: string; suggestedAction?: string; newElementId?: string };
}

async function handle(request: ContentRequest): Promise<ContentResponse> {
  try {
    const result = await dispatch(request);
    if (result.error) {
      return { ok: false, error: result.error.code, message: result.error.message, suggestedAction: result.error.suggestedAction };
    }
    return { ok: true, data: result.data ?? null };
  } catch (err) {
    if (err instanceof ToolError) {
      return { ok: false, error: err.code, message: err.message, suggestedAction: err.suggestedAction };
    }
    return { ok: false, error: "INTERNAL_ERROR", message: err instanceof Error ? err.message : String(err) };
  }
}

async function dispatch(request: ContentRequest): Promise<DispatchResult> {
  switch (request.kind) {
    case "get_snapshot": {
      const snap = snapshotForFrame(request.frameId, request.opts).snapshot;
      return { data: snap };
    }
    case "get_visible_text":
      return { data: visibleViewportText(request.maxChars) };
    case "get_links":
      return { data: refreshSnapshot({ maxLinks: request.maxLinks }).links };
    case "get_forms":
      return { data: refreshSnapshot({ includeValues: request.includeValues }).forms };
    case "get_structure":
      return { data: refreshSnapshot().headings };
    case "get_buttons":
      return { data: refreshSnapshot().elements.filter((e) => e.role === "button").map((e) => ({ id: e.id, name: e.name, visible: e.visible })) };
    case "get_inputs":
      return { data: refreshSnapshot({ includeValues: request.includeValues ?? false }).elements.filter((e) => ["input", "textarea", "select", "textbox"].includes(e.role)) };
    case "find_text": {
      const results: { elementId: string; context: string }[] = [];
      const regex = new RegExp(request.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      for (const el of document.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, h5, h6, li, td, span")) {
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (text && regex.test(text) && text.length < 500) {
          const id = el.closest("[data-ffa-eid]")?.getAttribute("data-ffa-eid");
          results.push({ elementId: id ?? "", context: text.slice(0, 300) });
          if (results.length >= request.maxResults) break;
        }
      }
      return { data: results };
    }
    case "click":
      return actions.clickElement(registry, request.elementId);
    case "focus":
      return actions.focusElement(registry, request.elementId);
    case "type_text":
      return actions.typeText(registry, request.elementId, request.text);
    case "clear_input":
      return actions.clearInput(registry, request.elementId);
    case "select_option":
      return actions.selectOption(registry, request.elementId, request.value);
    case "check":
      return actions.setChecked(registry, request.elementId, request.checked);
    case "scroll":
      return actions.scrollBy(request.dx, request.dy);
    case "scroll_to_element":
      return actions.scrollToElement(registry, request.elementId);
    case "hover":
      return actions.hoverElement(registry, request.elementId);
    case "press_key":
      return actions.pressKey(registry, request.elementId, request.key);
    case "restore_input":
      return actions.restoreInput(registry, request.elementId);
    case "undo_input":
      return actions.restoreInput(registry, request.elementId);
    case "get_input_history":
      return actions.getInputHistory(registry, request.elementId);
    case "extract_table":
      return extractTable(request.maxRows, request.maxCols);
    case "extract_list":
      return extractList(request.maxItems);
    case "extract_links":
      return extractLinks(request.maxLinks, request.filter);
    case "extract_structured_content":
      return extractStructuredContent(request.maxChars);
    case "describe_element": {
      const el = registry.resolve(request.elementId);
      if (!el) {
        return { error: { code: "ELEMENT_NOT_FOUND", message: `Element ${request.elementId} no longer exists.`, suggestedAction: "Refresh the page snapshot." } };
      }
      return {
        data: {
          name: describeElementName(el),
          role: describeElementRole(el),
          tag: el.tagName.toLowerCase(),
          type: el instanceof HTMLInputElement ? el.type : undefined,
          checked: el instanceof HTMLInputElement ? el.checked : undefined,
          inForm: !!el.closest("form"),
        },
      };
    }
    default: {
      const exhaustive: never = request;
      throw new ToolError("INTERNAL_ERROR", `Unknown content request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function describeElementName(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    if (el.id) {
      const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(el.id)}"]`);
      if (label?.textContent?.trim()) return label.textContent.trim();
    }
    const wrapped = el.closest("label");
    if (wrapped?.textContent?.trim()) return wrapped.textContent.trim();
    const ph = el.getAttribute("placeholder");
    if (ph?.trim()) return ph.trim();
    if (el instanceof HTMLInputElement && el.type === "password") return "password field";
    return el.name || el.type || el.tagName.toLowerCase();
  }
  return (el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
}

function describeElementRole(el: Element): string {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  if (el instanceof HTMLButtonElement) return "button";
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLInputElement) {
    if (el.type === "checkbox") return "checkbox";
    if (el.type === "radio") return "radio";
    if (el.type === "submit" || el.type === "button" || el.type === "reset") return "button";
    return "input";
  }
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  return el.tagName.toLowerCase();
}

// Notify the background of SPA navigations and DOM rewrites.
new DomObserver((reason) => {
  void browser.runtime.sendMessage({ type: "PAGE_CHANGED", url: location.href, reason });
}).start();

browser.runtime.onMessage.addListener((message: unknown, _sender) => {
  const request = message as ContentRequest;
  if (!request || typeof request !== "object" || !("kind" in request)) return undefined;
  return handle(request);
});

// Expose nothing to the page: no globals, no secrets, no DOM hooks beyond
// the data-ffa-eid attributes (harmless page-visible ids).
