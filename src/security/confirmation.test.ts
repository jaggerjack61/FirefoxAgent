import { describe, it, expect } from "vitest";
import { evaluateConfirmation, isIrreversible } from "./confirmation";
import type { ConfirmationContext } from "./confirmation";

const base: ConfirmationContext = { mode: "agent" };

describe("confirmation policy", () => {
  it("never requires confirmation for read-only tools", () => {
    for (const tool of ["list_tabs", "get_page_text", "get_workspace_tabs", "get_page_snapshot", "extract_table"]) {
      expect(evaluateConfirmation(tool, base).required).toBe(false);
    }
  });

  it("does not ask for approval to refresh a snapshot in interactive mode", () => {
    expect(evaluateConfirmation("get_page_snapshot", { mode: "interactive" }).required).toBe(false);
  });

  it("allows low-risk navigation in agent mode", () => {
    for (const tool of ["open_tab", "switch_tab", "scroll", "navigate", "reload_tab", "go_back", "search_web"]) {
      expect(evaluateConfirmation(tool, base).required).toBe(false);
    }
  });

  it("requires confirmation for every meaningful action in interactive mode", () => {
    expect(evaluateConfirmation("click_element", { mode: "interactive", elementName: "Pricing" }).required).toBe(true);
    expect(evaluateConfirmation("type_text", { mode: "interactive" }).required).toBe(true);
  });

  it("flags checkout buttons as high risk", () => {
    const decision = evaluateConfirmation("click_element", { ...base, elementName: "Place order" });
    expect(decision.required).toBe(true);
    expect(decision.highRisk).toBe(true);
  });

  it("flags payment words in page context as high risk", () => {
    const decision = evaluateConfirmation("click_element", {
      ...base,
      elementName: "Continue",
      pageUrl: "https://shop.example/checkout",
    });
    expect(decision.required).toBe(true);
    expect(decision.highRisk).toBe(true);
  });

  it("flags destructive actions", () => {
    const decision = evaluateConfirmation("click_element", { ...base, elementName: "Delete account" });
    expect(decision.required).toBe(true);
    expect(decision.highRisk).toBe(true);
  });

  it("flags sending actions (messages, replies)", () => {
    const decision = evaluateConfirmation("click_element", { ...base, elementName: "Send message" });
    expect(decision.required).toBe(true);
    expect(decision.highRisk).toBe(false);
  });

  it("flags typing into password fields as high risk", () => {
    const decision = evaluateConfirmation("type_text", { ...base, sensitiveField: true });
    expect(decision.required).toBe(true);
    expect(decision.highRisk).toBe(true);
  });

  it("flags form submissions", () => {
    expect(evaluateConfirmation("click_element", { ...base, submittingForm: true }).required).toBe(true);
    expect(evaluateConfirmation("press_key", { ...base, submittingForm: true }).required).toBe(true);
  });

  it("requires confirmation when closing many tabs", () => {
    expect(evaluateConfirmation("close_tab", { ...base, tabCount: 5 }).required).toBe(true);
    expect(evaluateConfirmation("close_tab", { ...base, tabCount: 1 }).required).toBe(false);
    expect(evaluateConfirmation("close_tabs", { ...base, tabCount: 3 }).required).toBe(true);
  });

  it("requires confirmation for login submissions", () => {
    const decision = evaluateConfirmation("click_element", { ...base, elementName: "Sign in" });
    expect(decision.required).toBe(true);
  });

  it("allows ordinary navigation clicks in agent mode", () => {
    expect(evaluateConfirmation("click_element", { ...base, elementName: "Pricing" }).required).toBe(false);
    expect(evaluateConfirmation("click_element", { ...base, elementName: "Documentation" }).required).toBe(false);
  });

  it("marks financial and destructive actions as irreversible", () => {
    expect(isIrreversible("click_element", { mode: "agent", elementName: "Buy now" })).toBe(true);
    expect(isIrreversible("click_element", { mode: "agent", elementName: "Delete" })).toBe(true);
    expect(isIrreversible("type_text", { mode: "agent", sensitiveField: true })).toBe(true);
    expect(isIrreversible("click_element", { mode: "agent", elementName: "Pricing" })).toBe(false);
  });
});
