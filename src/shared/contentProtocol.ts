/**
 * Typed protocol between the background script and content scripts.
 *
 * Element identifiers are frame-scoped strings: `"E3"` refers to an element
 * in the top frame, `"5:E3"` to element E3 inside the iframe with
 * webNavigation frameId 5. Background routes messages to the right frame.
 */

import type { ErrorCode } from "./errors";

// ---------------------------------------------------------------------------
// Snapshot model
// ---------------------------------------------------------------------------

export interface InteractiveElement {
  /** Frame-scoped id, e.g. "E3" or "5:E3" (frameId prefix). */
  id: string;
  /** ARIA-ish role: button | link | input | select | checkbox | radio | textarea | combobox | ... */
  role: string;
  /** Accessible name (aria-label, associated label, visible text...). */
  name: string;
  tag: string;
  type?: string;
  value?: string;
  checked?: boolean;
  href?: string;
  required?: boolean;
  /** True if the element has a nonzero bounding box. */
  visible: boolean;
  /** True when the element sits inside an iframe. */
  inFrame: boolean;
  /** webNavigation frameId (0 = top frame). */
  frameId: number;
}

export interface LinkInfo {
  text: string;
  href: string;
}

export interface FormFieldInfo {
  id?: string;
  name?: string;
  label: string;
  type: string;
  required: boolean;
  options?: string[];
  /** Always true when the field is a password input (never leaked). */
  isSensitive: boolean;
}

export interface FormInfo {
  fields: FormFieldInfo[];
  submitButtons: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  lang?: string;
  capturedAt: number;
  /** Bumped whenever the DOM/URL invalidates the snapshot. */
  version: number;
  elements: InteractiveElement[];
  /** Visible text (deduped, truncated to requested limit). */
  text: string;
  /** Heading outline (h1..h6). */
  headings: string[];
  links: LinkInfo[];
  forms: FormInfo[];
  tableCount: number;
  listCount: number;
  truncated: boolean;
  /** Added by the background gateway after its bounded network-idle wait. */
  networkIdle?: boolean;
}

export interface SnapshotRequestOptions {
  maxTextChars?: number;
  maxElements?: number;
  maxLinks?: number;
  /** When true, form field values are included (privacy-gated in background). */
  includeValues?: boolean;
  /** When true, iframe snapshots are merged into the result. */
  includeFrames?: boolean;
}

export interface FrameSnapshot {
  frameId: number;
  snapshot: PageSnapshot;
}

// ---------------------------------------------------------------------------
// Requests (background -> content)
// ---------------------------------------------------------------------------

export type ContentRequest =
  | { kind: "get_snapshot"; opts?: SnapshotRequestOptions; frameId: number }
  | { kind: "get_visible_text"; maxChars: number }
  | { kind: "get_links"; maxLinks: number; filter?: string }
  | { kind: "get_forms"; includeValues: boolean }
  | { kind: "get_structure" }
  | { kind: "get_buttons" }
  | { kind: "get_inputs"; includeValues?: boolean }
  | { kind: "find_text"; query: string; maxResults: number }
  | { kind: "click"; elementId: string }
  | { kind: "focus"; elementId: string }
  | { kind: "type_text"; elementId: string; text: string }
  | { kind: "clear_input"; elementId: string }
  | { kind: "select_option"; elementId: string; value: string }
  | { kind: "check"; elementId: string; checked: boolean }
  | { kind: "scroll"; dx: number; dy: number }
  | { kind: "scroll_to_element"; elementId: string }
  | { kind: "hover"; elementId: string }
  | { kind: "press_key"; key: string; elementId?: string }
  | { kind: "extract_table"; maxRows: number; maxCols: number }
  | { kind: "extract_list"; maxItems: number }
  | { kind: "extract_links"; maxLinks: number; filter?: string }
  | { kind: "extract_structured_content"; maxChars: number }
  | { kind: "describe_element"; elementId: string }
  | { kind: "restore_input"; elementId: string }
  | { kind: "undo_input"; elementId: string }
  | { kind: "get_input_history"; elementId: string };

// ---------------------------------------------------------------------------
// Responses (content -> background)
// ---------------------------------------------------------------------------

export type ContentResponse =
  | { ok: true; data: unknown }
  | {
      ok: false;
      error: ErrorCode;
      message: string;
      suggestedAction?: string;
      /** When ELEMENT_NOT_FOUND: best semantic candidate if one exists. */
      newElementId?: string;
    };

export interface ContentErrorDetail {
  code: ErrorCode;
  message: string;
  suggestedAction?: string;
}

export const elementIdForFrame = (frameId: number, localId: string): string =>
  frameId === 0 ? localId : `${frameId}:${localId}`;

export const splitElementId = (id: string): { frameId: number; localId: string } => {
  const idx = id.indexOf(":");
  if (idx === -1) return { frameId: 0, localId: id };
  const frame = Number(id.slice(0, idx));
  return { frameId: Number.isFinite(frame) ? frame : 0, localId: id.slice(idx + 1) };
};
