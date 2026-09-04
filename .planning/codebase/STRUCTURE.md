# Structure — YNAB4 Alternative SPA

## 1. Directory Tree (relevant levels)
```
.
├── apps/
│   └── web/                    # @ynab/web — Next.js 16 App Router host
│       └── src/
│           ├── app/
│           │   ├── layout.tsx
│           │   ├── globals.css
│           │   ├── (app)/[[...slug]]/page.tsx   # SPA catch-all view router
│           │   └── api/                        # REST handlers (thin)
│           │       ├── accounts/route.ts
│           │       ├── assignments/route.ts
│           │       ├── budget/route.ts
│           │       ├── categories/route.ts
│           │       ├── transactions/route.ts
│           │       ├── reconcile/route.ts
│           │       ├── recurring/route.ts
│           │       ├── rename-rules/route.ts
│           │       ├── duplicates/route.ts
│           │       ├── import/route.ts + import/csv/route.ts
│           │       ├── export/route.ts
│           │       ├── reset/route.ts
│           │       ├── health/route.ts
│           │       ├── diagnostics/balance-integrity/route.ts
│           │       ├── diagnostics/budget-integrity/route.ts
│           │       ├── schemas.ts + errors.ts
│           └── components/BudgetAppShell.tsx      # layout → ui/BudgetApp bridge
├── packages/
│   ├── logic/src/              # @ynab/logic — pure domain rules (no I/O)
│   │   ├── budget-engine.ts / reconcile.ts / recurring.ts
│   │   ├── duplicates.ts / rename-rules.ts / transfers.ts / split.ts
│   │   ├── csv-import.ts / reports.ts / format.ts / types.ts
│   │   ├── action-payloads.ts / payload-builders.ts / register.ts
│   │   └── seed-fixture.ts + index.ts
│   ├── server/src/             # @ynab/server — persistence + use-cases
│   │   ├── schema.ts / client.ts / index.ts
│   │   ├── migrate.ts / migrate-bootstrap.ts / seed.ts
│   │   ├── db-import.ts / db-reset.ts / transaction.ts / invariants.ts
│   │   ├── import-ynab4.ts / import-csv.ts / export-ynab4.ts
│   │   ├── queries/ (accounts, assignments, budget, categories, payees,
│   │   │          transactions, reconcile, recurring, rename-rules,
│   │   │          duplicates, diagnostics)
│   │   └── migrations/0000–0021_*.sql + meta/
│   ├── ui/src/                 # @ynab/ui — all React views
│   │   ├── BudgetApp.tsx (root) / Sidebar.tsx / Inspector.tsx
│   │   ├── BudgetView / TransactionsView / ReportsView (+ Spending,
│   │   │   Trends, NetWorth, ExpenseBreakdown, Projections, Calendar)
│   │   ├── RecurringView / SettingsView / MenuSettingsView
│   │   ├── Modals / BulkEditModal / ReconcileModal / CsvImportModal
│   │   └── ui.tsx / AmountInput.tsx / useLocalStorage.ts /
│   │       navVisibility.ts / chartUtils.tsx / ErrorBoundary.tsx / index.ts
│   └── theme/                  # design tokens
├── scripts/check-artifacts.mjs
├── budget.db (+ -shm/-wal) / budget.test.db* / backup.y4backup / import.csv
├── package.json / turbo.json / tsconfig.base.json / yarn.lock
└── .planning/codebase/ (this mapping)
```

## 2. Responsibilities by Area
- **`apps/web/src/app/(app)/`**: single SPA entry; slug → view selection. No domain logic.
- **`apps/web/src/app/api/`**: one folder per resource; parse + zod-validate → call `server/queries/*` → JSON response. `schemas.ts` = contract, `errors.ts` = uniform errors.
- **`apps/web/src/components/`**: `BudgetAppShell` only — mounts `ui/BudgetApp` inside root layout.
- **`packages/logic/`**: deterministic calculations and helpers reused by both client and server (budget math, recurrence expansion, duplicate detection, rename rules, transfer/split invariants, CSV parsing, report aggregations, payload factories).
- **`packages/server/queries/`**: one module per API domain; sole place issuing Drizzle/SQLite queries. `transaction.ts` wraps multi-step writes; `invariants.ts` + `diagnostics` verify integrity.
- **`packages/server/migrations/`**: append-only numbered SQL schema evolution (21 files, 0000–0021) applied by `migrate*.ts`.
- **`packages/ui/`**: feature views (Budget, Transactions, Reports ×5, Recurring, Settings) + `BudgetApp` global state + modals + primitives; no direct DB access, talks to `/api/*` only.
- **Root config**: `package.json` (workspaces + turbo scripts), `turbo.json` (task graph), `tsconfig.base.json` (shared TS), per-package `package.json` (`@ynab/*` names, `workspace:*` links).

## 3. Where to Add Things
| Task | Location |
|---|---|
| New page/view | `packages/ui/src/*View.tsx` + slug mapping in `apps/web/src/app/(app)/[[...slug]]/page.tsx` + `ui/navVisibility.ts` |
| New API endpoint | `apps/web/src/app/api/<name>/route.ts` + `schemas.ts`, implement in `packages/server/src/queries/<name>.ts` |
| New budget rule | `packages/logic/src/` (pure fn) + re-export in `index.ts`, call from `server/queries/*` or `ui/*` |
| New table/column | `packages/server/src/schema.ts` + new `migrations/NNNN_*.sql` |
| New shared component | `packages/ui/src/ui.tsx` or new file + `index.ts` export |
| New import/export format | `packages/server/src/import-*.ts` / `export-*.ts` + parsing help in `packages/logic/src/csv-import.ts` |

## 4. Notes / Gotchas
- DB files (`budget.db*`, `budget.test.db*`) live at repo root — do not commit; reset via `yarn db:reset`, migrate via `yarn db:migrate`.
- `apps/web` has only 2 source dirs (`app/`, `components/`); if logic appears there, it likely belongs in a package.
- Test setup mirrors packages: Vitest per package (`turbo run test`), Playwright e2e only in `apps/web`.
