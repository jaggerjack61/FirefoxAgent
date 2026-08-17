import { describe, it, expect } from "vitest";
import { elementIdentityHash, findBestSemanticMatch, matchScore, pickBestCandidate, type MatchCandidate } from "./semanticMatch";

const target: MatchCandidate = { id: "E1", role: "link", name: "Pricing", tag: "a", href: "https://x.test/pricing" };

describe("matchScore", () => {
  it("returns 0 for different roles", () => {
    expect(matchScore({ id: "E2", role: "button", name: "Pricing", tag: "button" }, target)).toBe(0);
  });

  it("scores exact name matches highest", () => {
    const exact = matchScore({ id: "E2", role: "link", name: "Pricing", tag: "a", href: "https://x.test/pricing" }, target);
    const partial = matchScore({ id: "E3", role: "link", name: "See Pricing", tag: "a" }, target);
    expect(exact).toBeGreaterThan(partial);
  });

  it("recovers a replaced element by stable DOM id when its label changes", () => {
    const changed = matchScore(
      { id: "E9", role: "button", name: "Continue to payment", tag: "button", domId: "checkout-next" },
      { id: "E2", role: "button", name: "Continue", tag: "button", domId: "checkout-next" },
    );
    expect(changed).toBeGreaterThanOrEqual(0.6);
  });
});

describe("findBestSemanticMatch", () => {
  it("finds the best match among candidates", () => {
    const candidates: MatchCandidate[] = [
      { id: "E9", role: "button", name: "Sign in", tag: "button" },
      { id: "E5", role: "link", name: "Pricing", tag: "a", href: "https://x.test/pricing" },
      { id: "E7", role: "link", name: "Contact", tag: "a" },
    ];
    const result = findBestSemanticMatch(target, candidates);
    expect(result.id).toBe("E5");
    expect(result.score).toBeGreaterThan(0.6);
  });

  it("returns low score when nothing matches well", () => {
    const candidates: MatchCandidate[] = [
      { id: "E9", role: "button", name: "Sign in", tag: "button" },
      { id: "E7", role: "link", name: "Contact", tag: "a" },
    ];
    const result = findBestSemanticMatch(target, candidates);
    expect(result.id).toBeUndefined();
    expect(result.score).toBeLessThan(0.6);
  });
});

describe("pickBestCandidate", () => {
  it("prefers exact role+name", () => {
    const candidates: MatchCandidate[] = [
      { id: "E1", role: "button", name: "Pricing", tag: "button" },
      { id: "E2", role: "link", name: "Pricing", tag: "a" },
    ];
    expect(pickBestCandidate(target, candidates)?.id).toBe("E2");
  });
});

describe("elementIdentityHash", () => {
  it("is deterministic", () => {
    const a = elementIdentityHash({ tag: "a", role: "link", name: "Pricing" });
    const b = elementIdentityHash({ tag: "a", role: "link", name: "Pricing" });
    expect(a).toBe(b);
  });

  it("differs when identity changes", () => {
    const a = elementIdentityHash({ tag: "a", role: "link", name: "Pricing" });
    const b = elementIdentityHash({ tag: "a", role: "link", name: "Contact" });
    expect(a).not.toBe(b);
  });

  it("ignores mutable form value and checked state", () => {
    const before = elementIdentityHash({ tag: "input", role: "checkbox", name: "Alerts", checked: false, value: "before" });
    const after = elementIdentityHash({ tag: "input", role: "checkbox", name: "Alerts", checked: true, value: "after" });
    expect(after).toBe(before);
  });
});
