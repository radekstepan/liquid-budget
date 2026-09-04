# Architecture — YNAB4 Alternative SPA

## 1. Overview
- **What it is:** YNAB4-compatible envelope-budgeting personal finance app (YNAB4 data model: budget months, category groups/categories, payees, accounts, transactions with splits/transfers, monthly assignments, reconciliations, recurring templates).
- **Monorepo:** Yarn 4 workspaces (`apps/*`, `packages/*`), orchestrated by Turborepo (`turbo.json`: `dev`, `build`, `lint`, `typecheck`, `test`, `coverage`).
- **Runtime:** Next.js 16 (App Router) + React 19 SPA in `apps/web`; SQLite (better-sqlite3 via Drizzle ORM) persisted in `budget.db` (+ `budget.test.db`); Tailwind CSS 4.
- **Style:** Server owns persistence/migrations/queries; `logic` owns pure domain rules; `ui` owns all views; `web` is thin glue (routes + API handlers + shell).

## 2. Components (packages / apps)

| Component | Path | Responsibility |
|---|---|---|
| `apps/web` (`@ynab/web`) | `apps/web/src/` | Next.js entry points: `app/layout.tsx`, `app/(app)/[[...slug]]/page.tsx` (single SPA catch-all), `app/api/*` REST handlers, `components/BudgetAppShell.tsx`. Depends on all three packages. |
| `packages/logic` (`@ynab/logic`) | `packages/logic/src/` | Pure domain logic, no I/O: `budget-engine.ts`, `reconcile.ts`, `recurring.ts`, `duplicates.ts`, `rename-rules.ts`, `csv-import.ts`, `transfers.ts`, `split.ts`, `reports.ts`, `format.ts`, `types.ts`, `action-payloads.ts` + `payload-builders.ts`, `register.ts`, `seed-fixture.ts`. |
| `packages/server` (`@ynab/server`) | `packages/server/src/` | Persistence + server use-cases: Drizzle `schema.ts`, `migrate.ts` / `migrate-bootstrap.ts`, `migrations/*.sql` (21 migrations), per-domain `queries/*.ts` (accounts, assignments, budget, categories, payees, transactions, reconcile, recurring, rename-rules, duplicates, diagnostics), `transaction.ts` (write orchestration), `invariants.ts`, `import-ynab4.ts` / `import-csv.ts` / `db-import.ts`, `export-ynab4.ts`, `seed.ts`, `db-reset.ts`, `client.ts` + `index.ts` barrel. |
| `packages/ui` (`@ynab/ui`) | `packages/ui/src/` | All React views/state: `BudgetApp.tsx` (root state machine), `Sidebar.tsx`, `BudgetView.tsx`, `TransactionsView.tsx`, `Inspector.tsx`, `ReportsView.tsx` + `SpendingReport/Trends/NetWorth/ExpenseBreakdown/Projections/Calendar` views, `RecurringView.tsx`, `SettingsView.tsx`, `MenuSettingsView.tsx`, `Modals.tsx` + `BulkEditModal/ReconcileModal/CsvImportModal`, `ui.tsx` primitives, `AmountInput.tsx`, `useLocalStorage.ts`, `navVisibility.ts`, `chartUtils.tsx`, `ErrorBoundary.tsx`. |
| `packages/theme` | `packages/theme/` | Design tokens / theming (Tailwind companion). |

## 3. Entry Points & Routing
- **Web entry:** `apps/web/src/app/layout.tsx` → `components/BudgetAppShell.tsx` → `@ynab/ui` `BudgetApp`. Client-side view routing via catch-all `app/(app)/[[...slug]]/page.tsx` (slug selects Budget/Transactions/Reports/Recurring/Settings views), with `navVisibility.ts` controlling sidebar.
- **API surface** (`apps/web/src/app/api/*/route.ts`, validated by `schemas.ts` + zod): `accounts`, `transactions`, `categories`, `assignments`, `budget`, `reconcile`, `recurring`, `rename-rules`, `duplicates`, `import` (+ `import/csv`), `export`, `reset`, `health`, `diagnostics/balance-integrity` + `diagnostics/budget-integrity`; shared error helper `errors.ts`.
- **Build/dev/test:** root `package.json` scripts delegate to `turbo run`; per-package `dev/build/typecheck/test`; Playwright e2e lives in `@ynab/web` (`e2e:server` uses `E2E_TESTING=true`).

## 4. Data Flow
1. **UI action** (`@ynab/ui` view/modal) builds a typed payload via `logic/payload-builders.ts` (`action-payloads.ts` types).
2. **API call** to `apps/web/src/app/api/*` route → zod validation (`schemas.ts`) → delegates to `packages/server` query/use-case.
3. **Server write** goes through `server/transaction.ts` orchestration + domain `queries/*.ts` against Drizzle `schema.ts` (SQLite `budget.db`); `invariants.ts` + diagnostics endpoints enforce balance/budget integrity.
4. **Reads** return JSON consumed by `BudgetApp` state; derived budget math (available-to-budget, rollover, overspend) computed by `logic/budget-engine.ts`; formatting via `logic/format.ts`.
5. **Import/export:** `.y4backup`/CSV in via `server/import-ynab4.ts` / `import-csv.ts` (with `logic/csv-import.ts`, `duplicates.ts`, `rename-rules.ts`), out via `server/export-ynab4.ts`.
6. **Migrations/seeding:** `server/migrate*.ts` apply `migrations/*.sql`; `server/seed.ts` and `logic/seed-fixture.ts` bootstrap dev/test DBs (`budget.test.db`).

## 5. Key Design Decisions / Constraints
- Thin-web / fat-packages: `apps/web` has almost no business logic; rules live in `logic`, I/O in `server`, presentation in `ui`.
- Pure vs. effectful split: `logic` is side-effect free and unit-testable; all SQLite/Drizzle access confined to `server`.
- Single SQLite file DB with Drizzle + numbered SQL migrations; integrity checked by diagnostics endpoints, not just FKs.
- Node >= 20, TypeScript 5.9, Vitest per package, Playwright for e2e.
