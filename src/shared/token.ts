export const TOKEN_LIMITS = {
  minimumContext: 8_000,
  defaultContext: 32_000,
  defaultOutputReserve: 2_048,
  developerPrompt: 700,
  toolDefinitions: 2_200,
  defaultPageResult: 900,
  maximumPageResult: 2_000,
  toolResult: 120,
  compactedSummary: 700,
  workspaceNotes: 800,
  recentPairs: 6,
  maxTurns: 12,
  maxActions: 25,
  maxRunMs: 5 * 60_000,
  maxWaitMs: 15_000,
} as const;

export function estimateTokens(value: string): number {
  if (!value) return 0;
  const bytes = new TextEncoder().encode(value).byteLength;
  return Math.max(1, Math.ceil(bytes / 3.2));
}

export function truncateToTokens(value: string, maximum: number): string {
  if (estimateTokens(value) <= maximum) return value;
  const suffix = "\n…[truncated]";
  const maximumBytes = Math.max(0, Math.floor(maximum * 3.2) - suffix.length);
  const encoded = new TextEncoder().encode(value);
  const clipped = new TextDecoder().decode(encoded.slice(0, maximumBytes));
  return clipped.replace(/[\s,;:]+$/u, "") + suffix;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, sortValue(entry)]),
    );
  }
  return value;
}

export function contentHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function createId(prefix: string): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${random}`;
}

export function lexicalTerms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length > 2),
  );
}

export function lexicalScore(query: string, candidate: string): number {
  const wanted = lexicalTerms(query);
  if (wanted.size === 0) return 0;
  const available = lexicalTerms(candidate);
  let score = 0;
  for (const term of wanted) {
    if (available.has(term)) score += 1;
  }
  return score / wanted.size;
}
