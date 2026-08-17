/**
 * Playwright-inspired actionability checks for content-script interactions.
 *
 * A WebExtension cannot inject trusted OS input like Playwright's browser
 * protocol can, but it can use the same readiness model: wait for the target
 * to be attached, visible, enabled/editable, stable, scrolled into view, and
 * unobscured before dispatching the DOM-level action.
 */

import type { ElementRegistry } from "../snapshot/registry";

const DEFAULT_ACTION_TIMEOUT_MS = 3_000;
const STABLE_FRAME_COUNT = 2;
const RECT_TOLERANCE_PX = 0.25;

export interface ActionPoint {
  x: number;
  y: number;
}

export interface ActionabilityOptions {
  enabled?: boolean;
  editable?: boolean;
  stable?: boolean;
  receivesEvents?: boolean;
  scrollIntoView?: boolean;
  timeoutMs?: number;
}

export type ActionabilityResult =
  | { ok: true; element: Element; point?: ActionPoint; waitedMs: number }
  | { ok: false; missing: boolean; reason: string; waitedMs: number };

interface RectSnapshot {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface HitTestResult {
  point?: ActionPoint;
  reason: string;
}

/** Waits and retries the checks that make a user-facing DOM action reliable. */
export async function waitForActionable(
  registry: ElementRegistry,
  localId: string,
  options: ActionabilityOptions,
): Promise<ActionabilityResult> {
  const startedAt = Date.now();
  const deadline = startedAt + (options.timeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS);
  let previousRect: RectSnapshot | undefined;
  let stableFrames = 0;
  let didScroll = false;
  let lastReason = "is not ready";

  while (true) {
    const element = registry.resolve(localId);
    if (!element) {
      return { ok: false, missing: true, reason: "is detached or stale", waitedMs: Date.now() - startedAt };
    }

    const rect = renderedRect(element);
    if (!rect) {
      previousRect = undefined;
      stableFrames = 0;
      lastReason = "is not visible";
    } else if (options.enabled && !isElementEnabled(element)) {
      lastReason = "is disabled";
    } else if (options.editable && !isElementEditable(element)) {
      lastReason = editabilityReason(element);
    } else {
      if (options.stable) {
        if (previousRect && sameRect(previousRect, rect)) stableFrames += 1;
        else stableFrames = 1;
        previousRect = rect;
        if (stableFrames < STABLE_FRAME_COUNT) lastReason = "is still moving";
      } else {
        stableFrames = STABLE_FRAME_COUNT;
      }

      if (stableFrames >= STABLE_FRAME_COUNT) {
        if (options.scrollIntoView && !didScroll && !fullyInsideViewport(rect)) {
          element.scrollIntoView({ behavior: "auto", block: "center", inline: "center" });
          didScroll = true;
          previousRect = undefined;
          stableFrames = 0;
          lastReason = "is being scrolled into view";
        } else if (options.receivesEvents) {
          const hit = hitTest(element);
          if (hit.point) {
            return { ok: true, element, point: hit.point, waitedMs: Date.now() - startedAt };
          }
          lastReason = hit.reason;
        } else {
          return { ok: true, element, waitedMs: Date.now() - startedAt };
        }
      }
    }

    if (Date.now() >= deadline) {
      return { ok: false, missing: false, reason: lastReason, waitedMs: Date.now() - startedAt };
    }
    await nextAnimationFrame();
  }
}

/** Native + ARIA disabled semantics, including disabled fieldsets/ancestors. */
export function isElementEnabled(element: Element): boolean {
  try {
    if (element.matches(":disabled")) return false;
  } catch {
    // Some non-HTML elements reject stateful pseudo-classes; ARIA still works.
  }
  if (element.closest("[aria-disabled='true'], [inert]")) return false;
  return true;
}

/** Whether type_text/clear_input can edit this element as a text control. */
export function isElementEditable(element: Element): boolean {
  if (!isElementEnabled(element)) return false;
  if (element.closest("[aria-readonly='true']")) return false;
  if (element instanceof HTMLTextAreaElement) return !element.readOnly;
  if (element instanceof HTMLInputElement) return !element.readOnly && isFillableInputType(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

export function isFillableInputType(type: string): boolean {
  return [
    "text",
    "search",
    "tel",
    "url",
    "email",
    "password",
    "number",
    "date",
    "time",
    "datetime-local",
    "month",
    "week",
    "color",
    "range",
  ].includes(type.toLowerCase());
}

function editabilityReason(element: Element): string {
  if (!isElementEnabled(element)) return "is disabled";
  if (element.closest("[aria-readonly='true']")) return "is read-only";
  if (element instanceof HTMLInputElement) {
    if (element.readOnly) return "is read-only";
    return `has non-text input type \"${element.type}\"`;
  }
  if (element instanceof HTMLTextAreaElement && element.readOnly) return "is read-only";
  return "is not editable";
}

function renderedRect(element: Element): RectSnapshot | null {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return null;
  const rects = [...element.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  if (!rects.length) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function sameRect(a: RectSnapshot, b: RectSnapshot): boolean {
  return Math.abs(a.x - b.x) <= RECT_TOLERANCE_PX
    && Math.abs(a.y - b.y) <= RECT_TOLERANCE_PX
    && Math.abs(a.width - b.width) <= RECT_TOLERANCE_PX
    && Math.abs(a.height - b.height) <= RECT_TOLERANCE_PX;
}

function fullyInsideViewport(rect: RectSnapshot): boolean {
  // Oversized elements can never fit entirely; hit-testing will pick a visible
  // point from their clipped rectangle after the single best-effort scroll.
  if (rect.width > window.innerWidth || rect.height > window.innerHeight) return false;
  return rect.x >= 0
    && rect.y >= 0
    && rect.x + rect.width <= window.innerWidth
    && rect.y + rect.height <= window.innerHeight;
}

function hitTest(element: Element): HitTestResult {
  let lastBlocker: Element | null = null;
  for (const clientRect of element.getClientRects()) {
    const left = Math.max(0, clientRect.left);
    const top = Math.max(0, clientRect.top);
    const right = Math.min(window.innerWidth, clientRect.right);
    const bottom = Math.min(window.innerHeight, clientRect.bottom);
    if (right - left < 1 || bottom - top < 1) continue;

    const insetX = Math.min(2, (right - left) / 4);
    const insetY = Math.min(2, (bottom - top) / 4);
    const points: ActionPoint[] = [
      { x: (left + right) / 2, y: (top + bottom) / 2 },
      { x: left + insetX, y: top + insetY },
      { x: right - insetX, y: top + insetY },
      { x: left + insetX, y: bottom - insetY },
      { x: right - insetX, y: bottom - insetY },
    ];
    for (const point of points) {
      const hit = document.elementFromPoint(point.x, point.y);
      if (hit && isComposedDescendant(hit, element)) return { point, reason: "" };
      if (hit) lastBlocker = hit;
    }
  }

  if (lastBlocker) return { reason: `does not receive pointer events because ${briefElement(lastBlocker)} intercepts them` };
  return { reason: "has no clickable point inside the viewport" };
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

function briefElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const name = element.getAttribute("aria-label")
    ?? element.getAttribute("title")
    ?? element.id;
  return name ? `<${tag}> \"${name.slice(0, 80)}\"` : `<${tag}>`;
}

function nextAnimationFrame(): Promise<void> {
  return new Promise((resolve) => {
    let finished = false;
    const done = () => {
      if (finished) return;
      finished = true;
      clearTimeout(fallback);
      resolve();
    };
    // requestAnimationFrame may be heavily throttled for a background tab.
    const fallback = window.setTimeout(done, 50);
    window.requestAnimationFrame(done);
  });
}
