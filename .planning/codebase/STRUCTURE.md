# Structure — YNAB4 Alternative SPA

## 1. Directory Tree (relevant levels)
```
.
├── apps/
│   └── web/                    # @ynab/web — Next.js 16 App Router host
│       └── src/
│           ├── app/
│           │   ├── layout.tsx          # root layout + theme init script
│           │   ├── globals.css
│           │   ├── (app)/[[...slug]]/page.tsx   # SPA catch-all: budget/reports/transactions only
│           │   └── api/                        # REST handlers (thin)
│           │       ├── accounts/route.ts
│           │       ├── assignments/route.ts
│           │       ├── budget/route.ts
│           │       ├── categories/route.ts
│           │       ├── payees/route.ts
│           │       ├── transactions/route.ts
│           │       ├── reconcile/route.ts
│           │       ├── recurring/route.ts
│           │       ├── rename-rules/route.ts + apply/ + suggest/
│           │       ├── duplicates/route.ts
│           │       ├── import/route.ts + import/csv/route.ts
│           │       ├── export/route.ts
│           │       ├── snapshots/route.ts
│           │       ├── reset/route.ts     # gated by RESET_ENABLED=true
│           │       ├── health/route.ts
│           │       ├── diagnostics/balance-integrity/route.ts
│           │       ├── diagnostics/budget-integrity/route.ts
│           │       ├── schemas.ts + errors.ts
│           └── components/BudgetAppShell.tsx      # layout → ui/BudgetApp bridge
├── packages/
│   ├── logic/src/              # @ynab/logic — pure domain rules (no I/O)
│   │   ├── budget-engine.ts / reconcile.ts / recurring.ts
│   │   ├── duplicates.ts / merge.ts / rename-rules.ts / rename-suggest.ts
│   │   ├── transfers.ts / split.ts / split-templates.ts
│   │   ├── search.ts / searchQuery.ts / csv-import.ts / reports.ts
│   │   ├── format.ts / types.ts / contracts.ts (zod) / page-title.ts
│   │   ├── action-payloads.ts / payload-builders.ts / register.ts
│   │   └── seed-fixture.ts + index.ts
│   ├── server/src/             # @ynab/server — persistence + use-cases
│   │   ├── schema.ts / client.ts / index.ts
│   │   ├── migrate.ts / migrate-bootstrap.ts / seed.ts
│   │   ├── db-import.ts / db-reset.ts / transaction.ts / invariants.ts
│   │   ├── import-ynab4.ts / import-csv.ts / export-ynab4.ts
│   │   ├── snapshots.ts / llm.ts (OpenAI-compatible chat client)
│   │   ├── queries/ (accounts, assignments, budget, categories, payees,
│   │   │          transactions, reconcile, recurring, rename-rules,
│   │   │          rename-suggest, duplicates, diagnostics)
│   │   └── migrations/0000–0025_*.sql + meta/   # 26 files, append-only
│   ├── ui/src/                 # @ynab/ui — all React views
│   │   ├── BudgetApp.tsx (root) / Sidebar.tsx / Inspector.tsx
│   │   ├── BudgetView / TransactionsView / ReportsView (+ Spending,
│   │   │   Trends, NetWorth, Surplus; ExpenseBreakdown unwired)
│   │   ├── PayeesView / SnapshotsView / ThemesView
│   │   ├── SettingsView / MenuSettingsView
│   │   ├── GlobalSearch / GlobalSearchModal / MergePreviewModal
│   │   ├── Modals / BulkEditModal / ReconcileModal / CsvImportModal
│   │   └── ui.tsx / AmountInput.tsx / useLocalStorage.ts / useTodayISO.ts /
│   │       navVisibility.ts / chartUtils.tsx / ErrorBoundary.tsx / index.ts
│   └── theme/                  # design tokens (themes.ts, blocks.tsx, primitives.tsx, index.css)
├── scripts/check-artifacts.mjs + free-port.sh
├── budget.db (+ -shm/-wal) / budget.test.db* / backup.y4backup / import.csv
├── snapshots/                  # `<id>.db` + `<id>.json` pairs (git-ignored)
├── package.json / turbo.json / tsconfig.base.json / yarn.lock
└── .planning/codebase/ (this mapping)
```

## 2. Responsibilities by Area
- **`apps/web/src/app/(app)/`**: single SPA entry; slug → one of 3 views (budget/reports/transactions). No domain logic.
- **`apps/web/src/app/api/`**: one folder per resource (in-process calls into `@ynab/server`); parse + zod-validate → call `server/queries/*` → JSON response. `schemas.ts` = contract, `errors.ts` = uniform errors.
- **`apps/web/src/components/`**: `BudgetAppShell` only — mounts `ui/BudgetApp` inside root layout.
- **`packages/logic/`**: deterministic calculations and helpers reused by both client and server (budget math incl. `computeBudget`/`buildBudgetIndex`, recurrence expansion, duplicate detection + merge, rename rules/suggestions, transfer/split invariants + split templates, CSV parsing, global-search parsing, report aggregations, payload factories, zod `contracts.ts`).
- **`packages/server/queries/`**: one module per API domain; sole place issuing Drizzle/SQLite queries. `transaction.ts` wraps multi-step writes (AsyncMutex); `invariants.ts` + `diagnostics` verify integrity.
- **`packages/server/migrations/`**: append-only numbered SQL schema evolution (26 files, 0000–0025) applied by `migrate*.ts` from `dist/migrations` (copied there by the `build` script).
- **`packages/ui/`**: feature views (Budget, Transactions, Reports ×4 wired tabs — Spending Trends, Spending by Category, Net Worth, Cash Flow — plus an unwired `ExpenseBreakdownReport.tsx`, Payees, Snapshots, Themes, Settings) + `BudgetApp` global state + modals + primitives; no direct DB access, talks to `/api/*` only.
- **Root config**: `package.json` (workspaces + turbo scripts), `turbo.json` (task graph), `tsconfig.base.json` (shared TS), per-package `package.json` (`@ynab/*` names, `workspace:*` links).

## 3. Where to Add Things
| Task | Location |
|---|---|
| New page/view | `packages/ui/src/*View.tsx` + sidebar entry (`Sidebar.tsx`/`navVisibility.ts`); only add a slug route if it must be deep-linkable (see `parseSlug`) |
| New API endpoint | `apps/web/src/app/api/<name>/route.ts` + `schemas.ts`, implement in `packages/server/src/queries/<name>.ts` |
| New budget rule | `packages/logic/src/` (pure fn) + re-export in `index.ts`, call from `server/queries/*` or `ui/*` |
| New table/column | `packages/server/src/schema.ts` + new `migrations/NNNN_*.sql` (append-only; `yarn db:generate` from `@ynab/web` writes into the server migrations dir) |
| New shared component | `packages/ui/src/ui.tsx` or new file + `index.ts` export |
| New import/export format | `packages/server/src/import-*.ts` / `export-*.ts` + parsing help in `packages/logic/src/csv-import.ts` |

## 4. Notes / Gotchas
- DB files (`budget.db*`, `budget.test.db*`) live at repo root — do not commit; reset via `yarn db:reset`, migrate via `yarn db:migrate`. Override the path with `DATABASE_URL`.
- `apps/web` has only 2 source dirs (`app/`, `components/`); if logic appears there, it likely belongs in a package. Note `next.config.ts` `transpilePackages` compiles workspace TS source directly — web does not consume package `dist` output.
- Test setup mirrors packages: Vitest per package (`turbo run test`), Playwright e2e only in `apps/web` (port 3100, `budget.test.db`, serial workers).
- Migrations run from `dist/migrations` at runtime — after adding a migration SQL file you must rebuild `@ynab/server` (all `db:*` scripts already do `yarn build` first; turbo `^build` covers tests).
