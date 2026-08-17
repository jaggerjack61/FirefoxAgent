/**
 * Pure semantic element matching. Used by the content script to assign
 * stable element identities and by the background to re-locate elements
 * after DOM mutations (stale-element recovery).
 *
 * Keep this module free of DOM access so it can be unit-tested directly.
 */

import { fnv1a } from "./id";
import type { InteractiveElement } from "./contentProtocol";

export interface ElementIdentityInput {
  tag: string;
  role: string;
  name: string;
  domId?: string;
  href?: string;
  type?: string;
  value?: string;
  checked?: boolean;
}

/** Deterministic identity hash for an interactive element. */
export function elementIdentityHash(input: ElementIdentityInput): string {
  return fnv1a(
    // Values and checked state are mutable interaction state, not identity.
    // Including them makes a stable id go stale immediately after a fill or
    // checkbox click, which defeats locator-style reuse.
    [input.tag, input.role, input.name.toLowerCase(), input.domId ?? "", input.href ?? "", input.type ?? ""].join("|"),
  );
}

/** Derives the identity input from an InteractiveElement. */
export function identityOfElement(el: InteractiveElement): ElementIdentityInput {
  return {
    tag: el.tag,
    role: el.role,
    name: el.name,
    domId: el.domId,
    href: el.href,
    type: el.type,
    value: el.value,
    checked: el.checked,
  };
}

// ---------------------------------------------------------------------------
// Semantic matching
// ---------------------------------------------------------------------------

export interface MatchCandidate {
  id: string;
  role: string;
  name: string;
  tag: string;
  domId?: string;
  type?: string;
  href?: string;
}

export interface SemanticMatchResult {
  /** Best candidate id, or undefined when nothing matches well enough. */
  id?: string;
  score: number;
}

const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * Scores a candidate against a target element description.
 * Returns a 0..1 score; >0.6 is a confident match.
 */
export function matchScore(candidate: MatchCandidate, target: MatchCandidate): number {
  const sameDomId = Boolean(candidate.domId && target.domId && candidate.domId === target.domId);
  if (candidate.role !== target.role && !sameDomId) return 0;
  let score = 0.25; // role matches

  if (sameDomId) score += 0.5;

  const cName = normalize(candidate.name);
  const tName = normalize(target.name);
  if (cName && tName) {
    if (cName === tName) score += 0.45;
    else if (cName.includes(tName) || tName.includes(cName)) score += 0.3;
  }

  if (candidate.tag === target.tag) score += 0.1;
  if (candidate.type && candidate.type === target.type) score += 0.1;
  if (candidate.href && target.href && candidate.href === target.href) score += 0.1;
  return Math.min(1, score);
}

const MIN_CONFIDENT_SCORE = 0.6;

/**
 * Finds the best semantic match for a stale element among fresh candidates.
 * Returns the new element id when found, otherwise undefined.
 */
export function findBestSemanticMatch(
  target: MatchCandidate,
  candidates: MatchCandidate[],
): SemanticMatchResult {
  let best: SemanticMatchResult = { score: 0 };
  for (const c of candidates) {
    const s = matchScore(c, target);
    if (s > best.score) best = { id: c.id, score: s };
  }
  if (best.score >= MIN_CONFIDENT_SCORE) return best;
  return { score: best.score };
}

/** Picks the best candidate among several by exact role+name first. */
export function pickBestCandidate(target: MatchCandidate, candidates: MatchCandidate[]): MatchCandidate | undefined {
  const exact = candidates.find((c) => c.role === target.role && normalize(c.name) === normalize(target.name));
  if (exact) return exact;
  const match = findBestSemanticMatch(target, candidates);
  return candidates.find((c) => c.id === match.id);
}
