/**
 * Privacy gating: decides what page data may leave the extension towards
 * the configured AI provider. Enforced in the background, before any
 * content is added to an LLM request.
 */

import type { PrivacySettings } from "@/shared/types";

export interface PageDataRequest {
  /** The tab being read (same as active tab → active page content). */
  isActiveTab: boolean;
  /** Requested payload types. */
  wants: {
    text: boolean;
    forms: boolean;
    links: boolean;
    snapshot: boolean;
  };
}

export interface PrivacyVerdict {
  allowed: boolean;
  /** Fields stripped from the request by policy. */
  stripped: string[];
  reason?: string;
}

/**
 * Applies privacy settings to a page-read request.
 * Password fields are always excluded regardless of settings.
 */
export function gatePageDataRequest(settings: PrivacySettings, req: PageDataRequest): PrivacyVerdict {
  const stripped: string[] = [];
  const allowContent = req.isActiveTab ? settings.allowActivePageContent : settings.allowOtherTabContent;

  if (!allowContent) {
    return {
      allowed: false,
      stripped: ["text", "forms", "links", "snapshot"],
      reason: req.isActiveTab
        ? "Sending active page content is disabled in privacy settings."
        : "Sending other-tab content is disabled in privacy settings.",
    };
  }

  if (req.wants.forms && !settings.allowFormValues) {
    stripped.push("formValues");
  }
  if (req.wants.text && !settings.allowSelectedText) {
    stripped.push("selectedText");
  }
  return { allowed: true, stripped };
}

/** Value masking applied to sensitive form fields in snapshots. */
export function maskSensitiveValue(value: string, type: string): string {
  if (type === "password") return "•".repeat(Math.min(value.length, 12));
  return value;
}

export function isSensitiveType(type: string): boolean {
  return type === "password" || type === "credit-card-number" || type === "cvv";
}
