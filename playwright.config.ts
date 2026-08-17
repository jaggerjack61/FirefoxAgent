import { defineConfig } from "@playwright/test";

/**
 * E2E strategy: Firefox does not allow Playwright to drive real WebExtension
 * sidebars, so these tests load the *built* sidebar UI in a plain browser
 * page and inject a scripted mock of the `browser.runtime` API. This gives
 * end-to-end coverage of the UI against a fake background agent.
 *
 * True extension-level smoke tests can be run with `web-ext run` manually
 * (see TESTING.md).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:4173",
    headless: true,
    // Use Chromium's current headless mode so E2E only needs the main
    // Chromium install, not the separate legacy headless-shell download.
    channel: "chromium",
  },
  webServer: {
    command: "npm run serve:preview",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 60_000,
  },
  projects: [{ name: "chromium" }],
});
