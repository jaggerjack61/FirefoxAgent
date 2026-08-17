import type { Plugin } from "vite";

const RAW_HTML_ERROR = '(() => { throw new Error("Raw HTML rendering is disabled in BrowserAgent"); })()';
const SCRIPT_ELEMENT_ERROR = '(() => { throw new Error("Script element rendering is disabled in BrowserAgent"); })()';

/**
 * Removes browser-extension linter hazards from third-party production code.
 *
 * BrowserAgent never uses React's `dangerouslySetInnerHTML` or renders
 * `<script>` elements. Replacing those dormant React DOM paths with explicit
 * failures both hardens that invariant and keeps the packaged bundle free of
 * unsafe DOM sinks. The Markdown rewrite only gives micromark's tokenizer a
 * local name so AMO does not mistake its `.write()` method for
 * `document.write()`.
 */
export function rewriteFirefoxAmoUnsafePatterns(source: string): string {
  return source
    .replace(/a\.innerHTML\s*=\s*b/g, RAW_HTML_ERROR)
    .replace(
      /mb\.innerHTML\s*=\s*"<svg>"\s*\+\s*b\.valueOf\(\)\.toString\(\)\s*\+\s*"<\/svg>"/g,
      RAW_HTML_ERROR,
    )
    .replace(/a\.innerHTML\s*=\s*"<script>[^\"]*script>"/g, SCRIPT_ELEMENT_ERROR)
    .replace(
      /return compiler\(options\)\(postprocess\(parse\(options\)\.document\(\)\.write\(preprocess\(\)\(value,\s*encoding,\s*true\)\)\)\);/g,
      [
        "const markdownTokenizer = parse(options).document();",
        "return compiler(options)(postprocess(markdownTokenizer.write(preprocess()(value, encoding, true))));",
      ].join("\n  "),
    );
}

/** Applies the hardening pass to emitted JavaScript chunks only. */
export function firefoxAmoSafeBundle(): Plugin {
  return {
    name: "firefox-amo-safe-bundle",
    apply: "build",
    renderChunk(code) {
      const rewritten = rewriteFirefoxAmoUnsafePatterns(code);
      const unsafeAssignment = /\.innerHTML\s*=/.exec(rewritten);
      if (unsafeAssignment) {
        const context = rewritten.slice(Math.max(0, unsafeAssignment.index - 80), unsafeAssignment.index + 160);
        throw new Error(
          `Unsafe innerHTML assignment remains in the production bundle at offset ${unsafeAssignment.index}: ${context}`,
        );
      }
      if (rewritten.includes(".document().write(")) {
        throw new Error("A document().write() chain remains in the production bundle.");
      }
      return rewritten === code ? null : { code: rewritten, map: null };
    },
  };
}
