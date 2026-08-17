import { describe, it, expect } from "vitest";
import { gatePageDataRequest, maskSensitiveValue, isSensitiveType } from "./privacy";
import type { PrivacySettings } from "@/shared/types";

const allOn: PrivacySettings = {
  allowActivePageContent: true,
  allowOtherTabContent: true,
  allowFormValues: true,
  allowSelectedText: true,
  excludeSensitiveFields: true,
};

describe("privacy gating", () => {
  it("allows active page content when enabled", () => {
    const verdict = gatePageDataRequest(allOn, {
      isActiveTab: true,
      wants: { text: true, forms: true, links: true, snapshot: true },
    });
    expect(verdict.allowed).toBe(true);
    expect(verdict.stripped).toEqual([]);
  });

  it("blocks active page content when disabled", () => {
    const verdict = gatePageDataRequest(
      { ...allOn, allowActivePageContent: false },
      { isActiveTab: true, wants: { text: true, forms: false, links: false, snapshot: true } },
    );
    expect(verdict.allowed).toBe(false);
  });

  it("blocks other-tab content when disabled", () => {
    const verdict = gatePageDataRequest(
      { ...allOn, allowOtherTabContent: false },
      { isActiveTab: false, wants: { text: true, forms: false, links: false, snapshot: true } },
    );
    expect(verdict.allowed).toBe(false);
  });

  it("strips form values when disabled", () => {
    const verdict = gatePageDataRequest(
      { ...allOn, allowFormValues: false },
      { isActiveTab: true, wants: { text: false, forms: true, links: false, snapshot: false } },
    );
    expect(verdict.allowed).toBe(true);
    expect(verdict.stripped).toContain("formValues");
  });

  it("masks sensitive values", () => {
    expect(maskSensitiveValue("hunter2", "password")).toBe("•••••••");
    expect(maskSensitiveValue("abc", "password")).toBe("•••");
    expect(isSensitiveType("password")).toBe(true);
    expect(isSensitiveType("text")).toBe(false);
  });
});
