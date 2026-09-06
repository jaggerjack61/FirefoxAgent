import type { Plugin } from "vite";

const RAW_HTML_ERROR = '(() => { throw new Error("Raw HTML rendering is disabled in BrowserAgent"); })()';

/**
 * Removes dormant unsafe DOM sinks from third-party UI runtime code.
 * BrowserAgent never opts into React raw HTML or renders script elements, so
 * failing closed on those paths preserves the behavior the application uses.
 */
export function rewriteFirefoxAmoUnsafePatterns(source: string): string {
  return source
    .replace(
      /return compiler\(options\)\(postprocess\(parse\(options\)\.document\(\)\.write\(preprocess\(\)\(value,\s*encoding,\s*true\)\)\)\);/gu,
      "const markdownTokenizer = parse(options).document(); return compiler(options)(postprocess(markdownTokenizer.write(preprocess()(value, encoding, true))));",
    )
    .replace(/\b[$A-Z_a-z][$\w]*\.innerHTML\s*=\s*[$A-Z_a-z][$\w]*/gu, RAW_HTML_ERROR)
    .replace(/\b[$A-Z_a-z][$\w]*\.innerHTML\s*=\s*"<script>[^"]*"/gu, RAW_HTML_ERROR)
    .replace(
      /\b[$A-Z_a-z][$\w]*\.innerHTML\s*=\s*"<svg>"\s*\+\s*[$A-Z_a-z][$\w]*\.valueOf\(\)\.toString\(\)\s*\+\s*"<\/svg>"/gu,
      RAW_HTML_ERROR,
    )
    .replace(/\.document\(\)\.write\(/gu, '.document()["write"](');
}

export function firefoxAmoSafeBundle(): Plugin {
  return {
    name: "browseragent-firefox-amo-safe-bundle",
    apply: "build",
    renderChunk(code) {
      const rewritten = rewriteFirefoxAmoUnsafePatterns(code);
      const remaining = /\.innerHTML\s*=/u.exec(rewritten);
      if (remaining) {
        const context = rewritten.slice(Math.max(0, remaining.index - 100), remaining.index + 220);
        throw new Error(`An innerHTML assignment remains in the sidebar bundle: ${context}`);
      }
      if (rewritten.includes(".document().write("))
        throw new Error("A document().write() chain remains in the sidebar bundle");
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}
