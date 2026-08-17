import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/** Sidebar React app build + dev server. */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": resolve(__dirname, "src") } },
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
