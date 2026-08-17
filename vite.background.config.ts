import { resolve } from "node:path";
import { defineConfig } from "vite";

/** Background script build (IIFE, no DOM). */
export default defineConfig({
  resolve: { alias: { "@": resolve(__dirname, "src") } },
  publicDir: false,
  build: {
    outDir: "dist/background",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(__dirname, "src/background/index.ts"),
      formats: ["iife"],
      name: "FirefoxAgentBackground",
      fileName: () => "index.js",
    },
  },
});
