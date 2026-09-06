import { describe, expect, it } from "vitest";
import { rewriteFirefoxAmoUnsafePatterns } from "./firefoxAmoSafeBundle";

describe("Firefox package hardening", () => {
  it("fails closed on dormant React raw-HTML assignments", () => {
    const source =
      'e.innerHTML=n;ke.innerHTML="<svg>"+n.valueOf().toString()+"</svg>";a.innerHTML="<script>\\x3c/script>";';
    const result = rewriteFirefoxAmoUnsafePatterns(source);
    expect(result).not.toContain("innerHTML=");
    expect(result).toContain("Raw HTML rendering is disabled");
  });

  it("disambiguates the Markdown tokenizer from document.write", () => {
    const result = rewriteFirefoxAmoUnsafePatterns(
      "return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));",
    );
    expect(result).not.toContain(".document().write(");
    expect(result).toContain("markdownTokenizer.write(");
  });
});
