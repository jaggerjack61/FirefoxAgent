/**
 * Confirmation policy engine — enforced OUTSIDE the model layer.
 *
 * The LLM can request any tool, but trusted extension code decides which
 * actions need explicit user approval. Rules are pure functions so they
 * are unit-testable and can never be influenced by page content.
 */

import type { AgentMode } from "@/shared/types";

export interface ConfirmationContext {
  mode: AgentMode;
  /** Current page URL (for detecting checkout/payment flows). */
  pageUrl?: string;
  /** Label/name of the target element when the action targets one. */
  elementName?: string;
  /** Number of tabs affected (close_tab). */
  tabCount?: number;
  /** URL being navigated to (navigate/open_tab). */
  targetUrl?: string;
  /** True when typing into a password/sensitive field. */
  sensitiveField?: boolean;
  /** True when the action would submit a form. */
  submittingForm?: boolean;
}

export interface ConfirmationDecision {
  required: boolean;
  highRisk: boolean;
  reason?: string;
}

// ---------------------------------------------------------------------------
// High-risk vocabulary (financial transactions, destructive actions)
// ---------------------------------------------------------------------------

const FINANCIAL_PATTERN =
  /(\bbuy\b|\bpurchase\b|\bcheckout\b|\bpay\b|\bpayment\b|\bplace order\b|\bconfirm order\b|\bsubmit order\b|\bcart\b|\bsubscribe\b|\brenew\b|\bdonate\b|\btip\b|\bbid\b)/i;

const DESTRUCTIVE_PATTERN =
  /(\bdelete\b|\bremove account\b|\bclose account\b|\bcancel subscription\b|\bunsubscribe\b|\bclear history\b|\bclear data\b|\berase\b)/i;

const SEND_PATTERN =
  /(\bsend\b|\bpost\b|\bpublish\b|\bsubmit\b|\bshare\b|\bcomment\b|\breply\b|\bemail\b|\bmessage\b)/i;

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Actions that are always safe reads — no confirmation in any mode. */
const READ_TOOLS = new Set([
  "list_tabs",
  "get_active_tab",
  "get_tab",
  "get_page_metadata",
  "get_page_text",
  "get_visible_text",
  "get_page_structure",
  "get_links",
  "get_forms",
  "get_buttons",
  "get_inputs",
  "find_text",
  "get_page_snapshot",
  "get_workspace_tabs",
  "get_workspace",
  "get_action_history",
  "extract_table",
  "extract_list",
  "extract_links",
  "extract_structured_content",
  "get_memory",
]);

/** Local context bookkeeping changes no browser/page state. */
const SAFE_CONTEXT_TOOLS = new Set([
  "summarize_tab",
  "remember_fact",
  "save_tab_notes",
  "add_tab_to_workspace",
  "remove_tab_from_workspace",
]);

export function isReadOnlyTool(toolName: string): boolean {
  return READ_TOOLS.has(toolName);
}

/** Tools that perform navigation — low risk, allowed in agent mode. */
const NAVIGATION_TOOLS = new Set([
  "open_tab",
  "switch_tab",
  "reload_tab",
  "duplicate_tab",
  "go_back",
  "go_forward",
  "navigate",
  "search_web",
  "scroll",
  "scroll_to_element",
  "hover_element",
  "focus_element",
]);

export function evaluateConfirmation(toolName: string, ctx: ConfirmationContext): ConfirmationDecision {
  // YOLO mode is an explicit user choice to disable policy confirmations.
  // The runtime separately bypasses tool-declared approvals in this mode;
  // schema validation, privacy, scope, and budgets remain enforced.
  if (ctx.mode === "yolo") return { required: false, highRisk: false };

  // 1. Read-only tools never require confirmation.
  if (READ_TOOLS.has(toolName) || SAFE_CONTEXT_TOOLS.has(toolName)) return { required: false, highRisk: false };

  // Downloads write arbitrary internet content to the user's device.
  if (toolName === "download_file") {
    return { required: true, highRisk: false, reason: "Downloading a file to this device." };
  }

  // 2. Interactive mode: anything beyond reads needs approval.
  if (ctx.mode === "interactive" && !NAVIGATION_TOOLS.has(toolName)) {
    return { required: true, highRisk: false, reason: "Interactive mode: approval required for browser actions." };
  }

  // 3. Sensitive fields: typing into password/credential fields.
  if (toolName === "type_text" && ctx.sensitiveField) {
    return { required: true, highRisk: true, reason: "Typing into a password or sensitive field." };
  }

  // 4. Form submission (explicit submit button or Enter on a submit control).
  if (toolName === "click_element" && ctx.submittingForm) {
    return { required: true, highRisk: false, reason: "Submitting a form." };
  }
  if (toolName === "press_key" && ctx.submittingForm) {
    return { required: true, highRisk: false, reason: "Submitting a form." };
  }

  // 5. Financial flows: checkout/payment button, or page URL in checkout flow.
  if (toolName === "click_element" || toolName === "press_key") {
    const name = ctx.elementName ?? "";
    if (FINANCIAL_PATTERN.test(name)) {
      return { required: true, highRisk: true, reason: `Action looks financial: "${name}".` };
    }
    if (ctx.pageUrl && /(checkout|payment|purchase|cart|order)/i.test(ctx.pageUrl)) {
      return { required: true, highRisk: true, reason: "The current page is a checkout/payment flow." };
    }
  }

  // 6. Destructive actions.
  if (toolName === "click_element") {
    const name = ctx.elementName ?? "";
    if (DESTRUCTIVE_PATTERN.test(name)) {
      return { required: true, highRisk: true, reason: `Action looks destructive: "${name}".` };
    }
  }

  // 7. Sending content (messages, posts, emails, replies).
  if (toolName === "click_element" || toolName === "press_key") {
    const name = ctx.elementName ?? "";
    if (SEND_PATTERN.test(name)) {
      return { required: true, highRisk: false, reason: `Action sends content: "${name}".` };
    }
  }

  // 8. Closing many tabs.
  if ((toolName === "close_tab" || toolName === "close_tabs") && (ctx.tabCount ?? 1) >= 3) {
    return { required: true, highRisk: false, reason: `Closing ${ctx.tabCount} tabs.` };
  }

  // 9. Navigating to a completely different host.
  if (toolName === "navigate" && ctx.targetUrl && ctx.pageUrl) {
    try {
      const from = new URL(ctx.pageUrl);
      const to = new URL(ctx.targetUrl);
      if (from.hostname !== to.hostname && !/^(about|moz-extension|chrome|file|data):/.test(to.protocol)) {
        return { required: ctx.mode === "interactive", highRisk: false, reason: `Navigate from ${from.hostname} to ${to.hostname}.` };
      }
    } catch {
      /* malformed URL — validation layer handles it */
    }
  }

  // 10. Login flows: clicking a login/sign-in button.
  if (toolName === "click_element") {
    const name = ctx.elementName ?? "";
    if (/(log in|login|sign in|sign-in|signin)/i.test(name)) {
      return { required: true, highRisk: false, reason: "Submitting login credentials." };
    }
  }

  return { required: false, highRisk: false };
}

/** True for tools whose execution is irreversible (beyond undo). */
export function isIrreversible(toolName: string, ctx: ConfirmationContext): boolean {
  if (toolName === "click_element") {
    const name = ctx.elementName ?? "";
    return FINANCIAL_PATTERN.test(name) || DESTRUCTIVE_PATTERN.test(name);
  }
  return toolName === "type_text" && !!ctx.sensitiveField;
}
