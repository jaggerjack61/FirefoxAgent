import { describe, expect, it } from "vitest";
import { rewriteFirefoxAmoUnsafePatterns } from "./firefoxAmoSafeBundle";

describe("Firefox AMO bundle hardening", () => {
  it("disables React raw-HTML assignments", () => {
    const source = [
      "a.innerHTML = b;",
      'mb.innerHTML = "<svg>" + b.valueOf().toString() + "</svg>";',
      'a.innerHTML = "<script><\\/script>";',
      "a.innerHTML=b;",
      'mb.innerHTML="<svg>"+b.valueOf().toString()+"</svg>";',
      'a.innerHTML="<script>\\x3c/script>";',
    ].join("\n");

    const rewritten = rewriteFirefoxAmoUnsafePatterns(source);

    expect(rewritten).not.toMatch(/\.innerHTML\s*=/);
    expect(rewritten).toContain("Raw HTML rendering is disabled");
    expect(rewritten).toContain("Script element rendering is disabled");
  });

  it("separates the Markdown tokenizer from its write call", () => {
    const source =
      "return compiler(options)(postprocess(parse(options).document().write(preprocess()(value, encoding, true))));";

    const rewritten = rewriteFirefoxAmoUnsafePatterns(source);

    expect(rewritten).not.toContain(".document().write(");
    expect(rewritten).toContain("markdownTokenizer.write(");
  });
});
