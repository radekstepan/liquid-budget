// Root flat config: ESLint recommended + typescript-eslint recommended.
// Every workspace `lint` script runs `eslint .` from its own directory;
// config resolution walks up to this file, so all packages share one ruleset.
// Hardened subset (landed): `eqeqeq` (null allowed — `!= null` is idiomatic
// here), `@typescript-eslint/consistent-type-imports`, `no-console` outside
// the logger funnel + CLI scripts + tests. Fixed alongside: unused `Category`
// import (budget-engine), unused `pre` (search), five value-imports used
// only as types.
// TODO(P2) [lint-harden]: remainder needs plugins/budget — jsx-a11y +
// import/no-cycle need new deps (not installed); no-non-null-assertion needs
// a ~200-site budget (sankey-heavy, 198 `!` today); complexity cap blocked
// (importTransactions 433, TransactionModal 136, payload-builders 122);
// narrow the import-ynab4 phase `any` carve-out to boundary files.
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
    // `eqeqeq` allows `!= null` (pervasive null/undefined check idiom);
    // `consistent-type-imports` keeps type-only imports erasable;
    // `no-console` funnels app logging through `lib/logger` (CLI scripts,
    // the funnel itself, and tests opt out below).
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "all" },
      ],
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { disallowTypeAnnotations: false },
      ],
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-console": "error",
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
    // CLI entry points report progress via stdout/stderr by design.
    rules: { "no-console": "off" },
  },
  {
    // The single sanctioned `console.*` funnel — app code logs via this
    // module (`getLogger`/`createScopedLogger`), never `console.*` direct.
    files: ["apps/web/src/lib/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    // The YNAB4 wire format is untyped JSON by nature: the archive/version/
    // scale/lineage boundary files read it as `unknown` through validated
    // guards (`import-ynab4/guards.ts`). Only the phase files below still
    // work row-typed `any` rows element-by-element; narrowing them is
    // follow-up work. Every other rule stays enforced here.
    files: [
      "packages/server/src/import-ynab4/phases/accounts.ts",
      "packages/server/src/import-ynab4/phases/budgets.ts",
      "packages/server/src/import-ynab4/phases/categories.ts",
      "packages/server/src/import-ynab4/phases/payees.ts",
      "packages/server/src/import-ynab4/phases/scheduled.ts",
      "packages/server/src/import-ynab4/phases/transactions.ts",
    ],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Test doubles capture untyped values (`api: any`, fetch stubs) by
    // design; the freedom stops at the test boundary. Console spies
    // (`vi.spyOn(console, ...)`) likewise live here, never in app code.
    files: ["**/tests/**", "**/*.test.ts", "**/*.test.tsx", "**/vitest.setup.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off", "no-console": "off" },
  },
  {
    // Marker-only block (no rules): the toolchain remainder lives in
    // package.json version pins, where JSON allows no comments.
    // Unify Vitest to one major once the v8 function-dedup artifact is
    // fixed upstream — see docs/toolchain-adr.md item 6. Logic/server/ui
    // stay on 2.1.9 (enforced coverage gate measures 93.4% functions
    // there vs 74.7% phantom-inflated on v4); web is on v4.
    // TODO(P2) [toolchain]: re-apply the v4 bump (vitest + coverage-v8,
    // ui vite ^6 + jest-dom ^7) and keep it only if `logic coverage` stays green.
    files: [
      "packages/logic/package.json",
      "packages/server/package.json",
      "packages/ui/package.json",
      "apps/web/package.json",
    ],
    rules: {},
  }
);
