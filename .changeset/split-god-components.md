---
"@ynab/ui": patch
"@ynab/web": patch
---

## Split god UI components; fix 28 e2e failures

Split the three largest UI modules into focused units with no behavior change (every moved body byte-verified against the original; public import surfaces preserved):

- `Modals.tsx` (2286 lines) → `modals/` — one file per modal (`TransactionModal`, `RecurringModal`, `AccountModal`, `CategoryModal`, `GroupModal`) plus `shared.tsx` for the split-draft helpers; `Modals.tsx` is now a barrel.
- `SpendingReport.tsx` (2291 lines) → `spending/` — `useSpendingFilters` / `useSpendingData` / `useSankeyDerived` hooks plus `SankeyDiagram`, `SpendingBars`, `SpendingControls`, and `SpendingTooltip` views behind a thin composer.
- `TransactionsView.tsx` (2172 lines) → `transactions/` — `useRegisterState` / `useRegisterData` / `useRegisterKeyboard` hooks plus `RegisterTable`, `ScheduledDrawer`, `RegisterToolbar`, `RegisterSummaryBar`, and `RegisterFooter` views behind a thin composer.

Regression cover added first: export-surface contract tests (`ModalsBarrel`, `SpendingReportSurface`, `TransactionsViewSurface`) alongside the existing suites. Full `@ynab/ui` suite green (819 tests) and all-workspace typecheck/build green.

Fixed 28 e2e failures (all pre-existing test rot, none caused by the split):

- 26 × disabled "Save Transaction": single-mode save has required an explicit category since the Sep 2 payload-builders commit, but the specs never picked one. Added a shared `selectModalOption` e2e helper and a category step (seed "Groceries", explicit Income for inflows) to every transaction-creating flow.
- Boundary-transfer inflow spec now uses the explicit "Income: Available this month" pick the modal forces (was: blank category, which the builder rejects); renamed accordingly.
- Reports Sankey spec: re-scoped the panel locator after the Merchants retitle orphans it, and disambiguated the "Other" merge assertion (exact + first).
- Cleared-flag geometry spec: clicks the balance cell instead of row center (a center click can land on the checkbox during layout settling, selecting instead of opening edit).

Notes: e2e suite confirmed green by a full `yarn e2e` run in a normal terminal.
