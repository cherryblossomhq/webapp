import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      // Plain-Node server code (the /api/proxy handler) — not part of the
      // browser TS project.
      "api",
      "server",
      "src/components/ui/**",
      "*.config.js",
      "*.config.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": [
        "warn",
        { allowConstantExport: true },
      ],
      // The new set-state-in-effect rule flags many legitimate init-from-prop
      // patterns (and shadcn's use-mobile). Downgrade to warn — promote later.
      "react-hooks/set-state-in-effect": "warn",
      // Default tseslint is strict on `any` — keep the rule on but downgrade
      // to warn so it doesn't block dev. Each `any` should be tracked.
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow leading underscore for intentionally-unused params/vars.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  }
);
