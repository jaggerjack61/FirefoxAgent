import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
    globals: false,
    restoreMocks: true,
    mockReset: true,
    testTimeout: 10_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: [
        "src/context/**/*.ts",
        "src/providers/**/*.ts",
        "src/security/**/*.ts",
        "src/shared/**/*.ts",
        "src/tools/**/*.ts",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
