import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(resolve("static/manifest.json"), "utf8")) as Record<string, unknown>;

describe("Firefox manifest", () => {
  it("has the minimal MV3 permission surface", () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["storage", "tabs", "scripting", "history", "bookmarks"]);
    expect(manifest.optional_host_permissions).toEqual(["<all_urls>"]);
    expect(JSON.stringify(manifest)).not.toMatch(/downloads|webRequest|webNavigation|activeTab/u);
  });

  it("exposes only local extension code", () => {
    expect(manifest).not.toHaveProperty("web_accessible_resources");
    expect(manifest.content_security_policy).toEqual({
      extension_pages: "script-src 'self'; object-src 'none'",
    });
  });
});
