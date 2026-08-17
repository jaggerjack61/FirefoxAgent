import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Content script build (IIFE). */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  publicDir: false,
  build: {
    outDir: "dist/content",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/content/index.ts"),
      formats: ["iife"],
      name: "FirefoxAgentContent",
      fileName: () => "index.js",
    },
  },
});
