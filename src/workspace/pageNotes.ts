/** Small, deterministic page-note helpers; no extra model call is required. */

export interface DerivedPageFact {
  text: string;
  category?: string;
}

export function derivePageSummary(title: string, text: string, headings: string[] = []): string {
  const selected: string[] = [];
  let length = 0;
  for (const candidate of splitInformativeText(text)) {
    if (candidate.length < 20 || candidate.length > 320) continue;
    if (length + candidate.length > 700) break;
    selected.push(candidate);
    length += candidate.length;
    if (selected.length >= 4) break;
  }
  const body = selected.join(" ") || headings.slice(0, 5).join("; ") || "Page inspected; no substantial text was available.";
  return `${title}: ${body}`.slice(0, 900);
}

export function derivePageFacts(text: string): DerivedPageFact[] {
  const factPattern = /(?:[$\u20ac\u00a3\u00a5]\s?\d|\b\d[\d,.]*\s?(?:%|gb|tb|mb|kb|ghz|mhz|hours?|hrs?|minutes?|mins?|days?|years?|stars?|reviews?|mah|wh|kg|g|lbs?|cm|mm|inches?)\b|\b(?:price|cost|total|version|released?|rating|ram|storage|battery|deadline|date)\b)/i;
  const seen = new Set<string>();
  const facts: DerivedPageFact[] = [];
  for (const candidate of splitInformativeText(text)) {
    const value = candidate.replace(/\s+/g, " ").trim().slice(0, 500);
    const key = value.toLowerCase();
    if (value.length < 4 || !factPattern.test(value) || seen.has(key)) continue;
    seen.add(key);
    facts.push({ text: value, category: inferFactCategory(value) });
    if (facts.length >= 10) break;
  }
  return facts;
}

function splitInformativeText(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
}

function inferFactCategory(text: string): string | undefined {
  if (/[$\u20ac\u00a3\u00a5]|\b(?:price|cost|total)\b/i.test(text)) return "price";
  if (/\b(?:gb|tb|ram|storage|ghz|battery|mah|wh)\b/i.test(text)) return "spec";
  if (/\b(?:date|released?|deadline|\d{4})\b/i.test(text)) return "date";
  if (/\b(?:rating|stars?|reviews?)\b/i.test(text)) return "rating";
  return undefined;
}
