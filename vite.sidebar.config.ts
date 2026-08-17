import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { firefoxAmoSafeBundle } from "./src/build/firefoxAmoSafeBundle";

/** Sidebar React app build + dev server. */
export default defineConfig({
  plugins: [react(), firefoxAmoSafeBundle()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
      // The package's browser build decodes entities through innerHTML. Its
      // static lookup implementation has identical output without a DOM sink.
      "decode-named-character-reference": resolve(
        __dirname,
        "node_modules/decode-named-character-reference/index.js",
      ),
    },
  },
  publicDir: false,
  root: resolve(__dirname, "src/sidebar"),
  base: "./",
  build: {
    outDir: resolve(__dirname, "dist/sidebar"),
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
  },
});
