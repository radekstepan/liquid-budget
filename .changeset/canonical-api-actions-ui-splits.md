---
"@ynab/logic": patch
"@ynab/server": patch
"@ynab/ui": patch
"@ynab/web": patch
---

## Canonical body-action API dispatch; BudgetApp/SpendingTrends splits; server-backed reports/search

Converge every action route on one canonical discriminator — body `{action}` — with `?action=` kept as a deprecated alias, and split the remaining god modules into focused units:

- API dispatch (`action.ts` `resolveAction`): transactions, recurring, rename-suggest, snapshots, and the remaining routes resolve body-first with legacy alias maps (e.g. `bulk-delete` → `delete`); all web API clients now send the canonical body spelling. Schemas accept an optional `action` discriminator where the alias must still validate.
- Shared `optimisticMutation(plan, request, rollback)` helper plus `reportBudgetReloadFailure`: the transactions/recurring/rename/accounts/categories/assignments/reconcile factories are migrated onto it (including the reconcile deferred-reload path), replacing three copies of the plan/request/rollback shape.
- New server-backed reads so large budgets skip the full dump: `GET /api/reports` (SQL-aggregated outflow/income/account-delta rows), `GET /api/search` (ranked cursor search mirroring the client index), and `GET /api/transactions` (keyset paging over date/id), each with a logic contract (`parseReportAggregatesResponse`, `parseSearchResponse`, `parseTransactionsPageResponse`).
- UI splits with no behavior change: `BudgetApp` → `useBudgetMonthNav` / `useBudgetMutations` / `useBudgetViewRouting` plus `GroupBlock`, `MonthCells`, `MonthQuickBudget`, `MonthCountControl`; `SpendingTrendsReport` → `useSpendingTrendsData` / `useSpendingTrendsLayout`, `SpendingTrendsTables`, `StaticChart`. Merge confirmations now take the survivor id from the server merge response instead of recomputing it client-side.
- Logic/server parity and privacy: `budget-walk` extracted from the budget engine, new `report-spending` module, shared `inferUncategorizedInflowIncome` / `rowNetOnBudgetDelta` transfer helpers used by both the server and the optimistic planner; rename-suggest sends payee names only (`LLM_INCLUDE_MEMOS=1` opts memos back in) with a PII-free audit trail and an in-UI notice; import-ynab4 guards, export streaming/indexes, reconcile idempotency, diagnostics storage, and structured `logger` routing throughout.
- Docs: fixed en-US/$ locale decision and toolchain ADR recorded; ESLint hardening with `lint-harden` coverage.

Fixed 3 e2e failures in the same commit:

- Canonical recurring post dropped the manual-post early flag, so "Enter Now" on a future schedule 409'd and the success toast never fired. The body branch now allows early posting exactly like the deprecated query spelling, with a route regression test covering it.
- The rename-suggest e2e mock only recognised `?action=accept`, so the canonical accept POST was fulfilled with the canned suggest response and the review modal stayed open. The mock now passes through either spelling.
- The transaction-edit spec never narrowed the virtualized register, so its back-dated row fell outside the rendered window (seed + auto-posted catch-up rows alone bury it — it ranks 28th of ~126 today). It now filters to the payee first, matching the file's own documented pattern.

Notes: unit suites green (incl. 34 focused route/contract tests), typecheck green, and the browser-free Playwright suites pass against a production build (`api.spec.ts` 16/16, request-only rename-suggest 2/2, plus direct HTTP checks of the post/accept paths). Browser specs could not run in the agent sandbox (Chromium SIGSEGVs at launch there) — confirm with `yarn e2e` in a normal terminal.
