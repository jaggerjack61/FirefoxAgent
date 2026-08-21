/**
 * Structured content extractors: tables, lists, links, and main-content
 * text. All outputs are capped to keep token usage bounded.
 */

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…` : s);

function cellText(cell: Element): string {
  return cap((cell.textContent ?? "").replace(/\s+/g, " ").trim(), 200);
}

/** Best table = the one with the most cells (usually the data table). */
function bestTable(): HTMLTableElement | null {
  let best: HTMLTableElement | null = null;
  let bestCells = 0;
  for (const table of document.querySelectorAll<HTMLTableElement>("table")) {
    const cells = table.querySelectorAll("td, th").length;
    if (cells > bestCells) {
      bestCells = cells;
      best = table;
    }
  }
  return best;
}

export function extractTable(maxRows: number, maxCols: number): Record<string, unknown> {
  const table = bestTable();
  if (!table) return { found: false, reason: "no <table> element on this page" };
  const headerRow = table.querySelector("thead tr") ?? table.querySelector("tr");
  const headers = headerRow
    ? [...headerRow.querySelectorAll("th, td")].map((c) => cellText(c)).slice(0, maxCols)
    : [];
  const rows: string[][] = [];
  for (const tr of table.querySelectorAll("tbody tr, tr")) {
    if (tr === headerRow) continue;
    const cells = [...tr.querySelectorAll("td, th")].map((c) => cellText(c)).slice(0, maxCols);
    if (cells.length === 0) continue;
    rows.push(cells);
    if (rows.length >= maxRows) break;
  }
  return { found: true, tableCount: document.querySelectorAll("table").length, headers, rows, truncated: rows.length >= maxRows };
}

export function extractList(maxItems: number): Record<string, unknown> {
  const lists = [...document.querySelectorAll<HTMLUListElement | HTMLOListElement>("ul, ol")].filter(
    (l) => l.querySelectorAll("li").length >= 2,
  );
  if (lists.length === 0) return { found: false, reason: "no substantial list found" };
  const items: string[] = [];
  for (const li of lists[0].querySelectorAll("li")) {
    const text = cap((li.textContent ?? "").replace(/\s+/g, " ").trim(), 200);
    if (text) items.push(text);
    if (items.length >= maxItems) break;
  }
  return { found: true, listCount: lists.length, items, truncated: items.length >= maxItems };
}

export function extractLinks(maxLinks: number, filter?: string): Record<string, unknown> {
  const links: { text: string; href: string }[] = [];
  const re = filter ? new RegExp(filter, "i") : null;
  for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const text = cap((a.textContent ?? "").replace(/\s+/g, " ").trim(), 120);
    if (!text || !a.href) continue;
    if (re && !re.test(text) && !re.test(a.href)) continue;
    // Cap long tracking/redirect URLs so they do not waste tokens.
    links.push({ text, href: cap(a.href, 256) });
    if (links.length >= maxLinks) break;
  }
  return { count: links.length, links, truncated: links.length >= maxLinks };
}

export function extractStructuredContent(maxChars: number): Record<string, unknown> {
  const root = document.querySelector("main") ?? document.querySelector("article") ?? document.body;
  if (!root) return { found: false };
  const blocks: string[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("h1, h2, h3, h4, p, li, pre, blockquote")) {
    if (blocks.join("\n").length > maxChars) break;
    const text = cap((el.textContent ?? "").replace(/\s+/g, " ").trim(), 400);
    if (!text) continue;
    if (/^h\d$/i.test(el.tagName)) blocks.push(`## ${text}`);
    else if (el.tagName === "PRE") blocks.push(`\`\`\`\n${text}\n\`\`\``);
    else if (el.tagName === "LI") blocks.push(`- ${text}`);
    else blocks.push(text);
  }
  const content = blocks.join("\n").slice(0, maxChars);
  return { found: content.length > 0, content, truncated: content.length >= maxChars };
}
