import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["coverage/**", "dist/**", "node_modules/**", "source-artifacts/**", "web-ext-artifacts/**"] },
  {
    ...js.configs.recommended,
    files: ["**/*.{js,mjs}"],
    languageOptions: { globals: globals.node },
  },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: ["**/*.{ts,tsx}"] })),
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    languageOptions: {
      globals: {
        ...globals.browser,
        browser: "readonly",
      },
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "no-undef": "off",
    },
  },
);
