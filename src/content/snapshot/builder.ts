/**
 * Builds the compact semantic page snapshot: interactive elements with
 * stable ids, deduped visible text, headings, links and form summaries.
 * Raw HTML/CSS classes are intentionally not exposed.
 */

import type { FormInfo, InteractiveElement, PageSnapshot } from "@/shared/contentProtocol";
import { accessibleName } from "./accessibleName";
import { ElementRegistry, hasJavaScriptClickBehavior } from "./registry";

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='textbox']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='combobox']",
  "[role='switch']",
  "[role='searchbox']",
  "[role='menuitem']",
  "[role='tab']",
  "[role='slider']",
  "[contenteditable='true']",
  "[onclick]",
  "[onmousedown]",
  "[onmouseup]",
  "[onpointerdown]",
  "[onpointerup]",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export interface SnapshotBuilderOptions {
  registry: ElementRegistry;
  frameId: number;
  includeValues: boolean;
  maxTextChars: number;
  maxElements: number;
  maxLinks: number;
}

export function buildSnapshot(opts: SnapshotBuilderOptions): PageSnapshot {
  const { registry, frameId, includeValues } = opts;

  const elements: InteractiveElement[] = [];
  const seen = new Set<Element>();
  if (opts.maxElements > 0) {
    const semanticCandidates = new Set(document.querySelectorAll<Element>(INTERACTIVE_SELECTOR));
    // Property-assigned handlers (el.onclick = ...) do not necessarily create
    // an [onclick] attribute, so include those while walking in document order.
    for (const el of document.querySelectorAll<Element>("*")) {
      if (!semanticCandidates.has(el) && !hasJavaScriptClickBehavior(el)) continue;
      if (seen.has(el)) continue;
      seen.add(el);
      const localId = registry.register(el);
      if (!localId) continue;
      const interactive = registry.toInteractive(el, frameId, includeValues);
      elements.push(interactive);
      if (elements.length >= opts.maxElements) break;
    }
  }
  // Sort: visible interactive elements first, then stable order.
  elements.sort((a, b) => Number(b.visible) - Number(a.visible) || a.id.localeCompare(b.id, undefined, { numeric: true }));

  const rawText = visibleText();
  const truncated = rawText.length > opts.maxTextChars;
  const text = truncated ? rawText.slice(0, opts.maxTextChars) : rawText;

  return {
    url: location.href,
    title: document.title || location.hostname,
    lang: document.documentElement.lang || undefined,
    capturedAt: Date.now(),
    version: Date.now(),
    elements,
    text,
    headings: collectHeadings(),
    links: collectLinks(opts.maxLinks),
    forms: collectForms(),
    tableCount: document.querySelectorAll("table").length,
    listCount: document.querySelectorAll("ul, ol").length,
    truncated,
  };
}

function visibleText(): string {
  const body = document.body;
  if (!body) return "";
  const text = (body.innerText ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // Dedupe consecutive repeated lines (common in virtualized lists).
  const deduped = text.filter((line, i) => line !== text[i - 1]);
  return deduped.join("\n");
}

/** Text whose rendered parent intersects the current viewport. */
export function visibleViewportText(maxChars: number): string {
  const body = document.body;
  if (!body || maxChars <= 0) return "";
  const lines: string[] = [];
  const seen = new Set<string>();
  let textLength = 0;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    const value = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (parent && value) {
      const style = window.getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      const intersectsViewport = rect.width > 0
        && rect.height > 0
        && rect.bottom >= 0
        && rect.right >= 0
        && rect.top <= window.innerHeight
        && rect.left <= window.innerWidth;
      if (style.display !== "none" && style.visibility !== "hidden" && intersectsViewport && !seen.has(value)) {
        seen.add(value);
        lines.push(value);
        textLength += value.length + (lines.length > 1 ? 1 : 0);
        if (textLength >= maxChars) break;
      }
    }
    node = walker.nextNode();
  }
  return lines.join("\n").slice(0, maxChars);
}

function collectHeadings(): string[] {
  const out: string[] = [];
  for (const h of document.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const text = (h.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text) out.push(`${h.tagName.toLowerCase()}: ${text}`);
  }
  return out.slice(0, 60);
}

function collectLinks(maxLinks: number): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  if (maxLinks <= 0) return out;
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const text = (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || !a.href) continue;
    out.push({ text, href: a.href });
    if (out.length >= maxLinks) break;
  }
  return out;
}

const SENSITIVE_TYPES = new Set(["password"]);

function collectForms(): FormInfo[] {
  const forms: FormInfo[] = [];
  for (const form of document.querySelectorAll<HTMLFormElement>("form")) {
    const fields: FormInfo["fields"] = [];
    for (const el of form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
      "input, select, textarea",
    )) {
      const isSensitive = SENSITIVE_TYPES.has(el.type) || (el.getAttribute("autocomplete") ?? "").toLowerCase() === "current-password";
      fields.push({
        id: el.id || undefined,
        name: el.name || undefined,
        label: accessibleName(el),
        type: el.type || el.tagName.toLowerCase(),
        required: el.required,
        options: el instanceof HTMLSelectElement ? [...el.options].map((o) => o.text).slice(0, 40) : undefined,
        isSensitive,
      });
    }
    const submitButtons = [...form.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button[type='submit'], input[type='submit']")]
      .map((b) => accessibleName(b))
      .filter(Boolean);
    forms.push({ fields: fields.slice(0, 80), submitButtons });
  }
  return forms;
}
