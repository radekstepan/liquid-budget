---
"@ynab/logic": patch
"@ynab/server": patch
"@ynab/theme": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Split remaining god modules; extract API/optimistic helpers; wire ESLint

Continues the module split from `27d8dc3` into the server, logic, and web
shell:

- `packages/server/src/import-ynab4.ts` → `import-ynab4/` — archive/version
  helpers, settings XML, amounts, lineage, and a phased import pipeline.
- `packages/server/src/queries/transactions.ts` → `queries/transactions/` —
  per-operation modules for create, update, remove, splits, merge, bulk
  update, account moves, and validation.
- `packages/logic/src/sankey.ts` → `sankey/` — direct, flow, funding,
  geometry, grouped, merge, and style modules behind the original barrel.
- `packages/ui/src/BudgetApp.tsx` → `usePrivacyBudget`, `useBudgetUrlSync`,
  `useQuickBudget`, `useSettingsData`, and `BudgetAppApi`, preserving every
  public import surface.
- `apps/web/src/components/BudgetAppShell.tsx` → `components/api/` factories
  (`accounts`, `transactions`, `recurring`, `reconcile`, `rename`, ...),
  `useToasts`, and shared `jsonReq`/mutation dependencies.
- Optimistic state transitions move from the shell into pure
  `@ynab/logic` `optimistic.ts`, covered by 40 new unit tests.
- Add a root ESLint flat config and wire every workspace `lint` script to it;
  clear `any`/empty-catch lint debt across logic, server, theme, ui, and web.
- API handlers share `action.ts` dispatch helpers plus unknown-safe error
  extraction.

Notes: refactor and tooling work, no intentional user-facing behavior change.
`yarn lint`, `yarn typecheck`, `yarn test`, `yarn build`, and the full
`yarn e2e` suite (191 tests) all pass.
