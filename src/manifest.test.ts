import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface FirefoxManifest {
  name?: string;
  description?: string;
  sidebar_action?: { default_title?: string };
  action?: { default_title?: string };
  browser_specific_settings?: {
    gecko?: {
      strict_min_version?: string;
      data_collection_permissions?: {
        required?: string[];
      };
    };
    gecko_android?: {
      strict_min_version?: string;
    };
  };
}

describe("Firefox manifest", () => {
  it("uses trademark-neutral distributable branding", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"),
    ) as FirefoxManifest;

    expect(manifest.name).toBe("BrowserAgent");
    const displayMetadata = [
      manifest.name,
      manifest.description,
      manifest.sidebar_action?.default_title,
      manifest.action?.default_title,
    ].join(" ");
    expect(displayMetadata).not.toMatch(/mozilla|firefox/i);
  });

  it("declares the data transmitted to the configured AI provider", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../static/manifest.json", import.meta.url), "utf8"),
    ) as FirefoxManifest;

    expect(manifest.browser_specific_settings?.gecko).toMatchObject({
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: [
          "authenticationInfo",
          "browsingActivity",
          "personalCommunications",
          "searchTerms",
          "websiteActivity",
          "websiteContent",
        ],
      },
    });
    expect(manifest.browser_specific_settings?.gecko_android).toEqual({
      strict_min_version: "142.0",
    });
  });
});
