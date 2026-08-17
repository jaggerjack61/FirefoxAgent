import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("package scripts", () => {
  it("uses the BrowserAgent package identity", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { name?: string; description?: string };

    expect(pkg.name).toBe("browser-agent");
    expect(`${pkg.name} ${pkg.description}`).not.toMatch(/mozilla|firefox/i);
  });

  it("replaces stale generated extension archives", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(pkg.scripts?.package).toContain("--overwrite-dest");
  });
});
