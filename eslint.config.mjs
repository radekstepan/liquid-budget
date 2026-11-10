// Root flat config: ESLint recommended + typescript-eslint recommended.
// Every workspace `lint` script runs `eslint .` from its own directory;
// config resolution walks up to this file, so all packages share one ruleset.
// TODO(P2) [lint-harden]: adopt jsx-a11y + import/no-cycle (budget-engine<->transfers risk) +
// no-non-null-assertion budget + complexity cap; narrow import-ynab4 any carve-out to boundary files.
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.turbo/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "**/.yarn/**",
      "repomix-output.xml",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // `_`-prefixed names are deliberately unused (callback arity, stubbed
    // params); unused catch params are still errors — use `catch {`.
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" },
      ],
    },
  },
  {
    // Node runtimes: scripts, configs, and the seed/migration CLIs.
    files: [
      "scripts/**/*.mjs",
      "**/vitest.config.ts",
      "**/vitest.setup.ts",
      "**/playwright.config.ts",
      "**/next.config.ts",
      "**/postcss.config.mjs",
      "apps/web/scripts/**/*.ts",
      "packages/server/src/db-*.ts",
      "packages/server/src/migrate*.ts",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // The YNAB4 wire format is untyped JSON by nature: the whole import
    // pipeline works on `any` documents validated field-by-field at read
    // sites. Narrowing the entire backup schema to `unknown` is follow-up
    // work; every other rule stays enforced here.
    // TODO(P2) [type-safety]: schedule unknown-migration for import-ynab4 boundary files; narrow
    // any carve-out from whole pipeline to per-file boundaries with validated read sites.
    files: ["packages/server/src/import-ynab4/**"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Test doubles capture untyped values (`api: any`, fetch stubs) by
    // design; the freedom stops at the test boundary.
    files: ["**/tests/**", "**/*.test.ts", "**/*.test.tsx", "**/vitest.setup.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  }
);
